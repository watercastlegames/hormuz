"""실제 게임 플레이 영상을 만든다.

화면 녹화가 아니다. 게임의 시간을 직접 한 프레임씩 밀면서 찍는다.
그래서 찍는 속도가 느려도 결과 영상은 매끄럽고, 몇 번을 다시 찍어도 같은 장면이 나온다.

원리
    게임은 requestAnimationFrame 으로 스스로 돌고, performance.now() 로 시간을 읽는다.
    그 둘을 잠깐 가로챈다 — 스스로 도는 것을 멈추고, 시계를 우리가 돌린다.

실행:
    python tools/render-gameplay.py                       기본(대규모 함대전 20초)
    python tools/render-gameplay.py --scenario tanker_rescue --seconds 25
    python tools/render-gameplay.py --shape 9:16          쓰레드용 세로
    python tools/render-gameplay.py --google 1            구글 3D 지형 위에서
"""
import argparse
import pathlib
import shutil
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "output/model-pack/video"
SIZES = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)}
GPU_ARGS = ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"]

SCENARIOS = {
    "large_fleet_battle": "대규모 함대전",
    "convoy_shield": "해협 방패",
    "tanker_rescue": "라락 구출작전",
    "mine_corridor": "기뢰 회랑",
    "missile_screen": "미사일 차단막",
    "coastal_battery": "해안 포대",
    "pickaxe_mountain": "곡괭이산",
}

# 게임의 시계와 자동 반복을 가로챈다.
# animate 를 빈 함수로 바꾸면 이미 예약된 다음 호출이 아무 일도 하지 않아 루프가 끊긴다.
# 그 뒤로는 우리가 원래 함수를 직접 부르면서 시계를 원하는 만큼만 민다.
INSTALL_FILM = """() => {
  const battle = window.__HORMUZ_RTS__.battle;
  const original = battle.animate.bind(battle);
  battle.animate = function () {};
  const realNow = performance.now.bind(performance);
  let clock = realNow();
  performance.now = () => clock;
  battle.lastFrame = clock;
  window.__GAMEFILM__ = {
    step(seconds) { clock += seconds * 1000; original(); },
    end() { performance.now = realNow; battle.animate = original; original(); }
  };
  return true;
}"""

HIDE_CURSOR = """() => {
  const style = document.createElement('style');
  style.textContent = '* { cursor: none !important; }';
  document.head.appendChild(style);
}"""


def find_ffmpeg():
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", default="large_fleet_battle", choices=sorted(SCENARIOS))
    parser.add_argument("--shape", default="16:9", choices=sorted(SIZES))
    parser.add_argument("--seconds", type=float, default=20)
    parser.add_argument("--warmup", type=float, default=6,
                        help="찍기 전에 흘려보낼 게임 시간. 교전이 붙은 뒤부터 담는다")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--difficulty", type=int, default=3)
    parser.add_argument("--google", default="0", choices=("0", "1"))
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--quality", type=int, default=94)
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print("ffmpeg 를 찾지 못했다.")
        return 1

    width, height = SIZES[args.shape]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    target = pathlib.Path(args.out) if args.out else (
        OUT_DIR / f"hormuz-gameplay-{args.scenario}-{args.shape.replace(':', 'x')}.mp4")

    encoder = subprocess.Popen([
        ffmpeg, "-y", "-loglevel", "error",
        "-f", "image2pipe", "-framerate", str(args.fps), "-i", "-",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
        "-preset", "medium", "-movflags", "+faststart", str(target)
    ], stdin=subprocess.PIPE)

    started = time.time()
    total = round(args.seconds * args.fps)
    written = 0
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=GPU_ARGS)
            page = browser.new_page(viewport={"width": width, "height": height})
            failures = []
            page.on("pageerror", lambda error: failures.append(str(error)[:120]))

            url = (f"{args.base}/rts-combat.html?scenario={args.scenario}"
                   f"&lang=ko&google={args.google}&difficulty={args.difficulty}")
            print(f"{SCENARIOS[args.scenario]} · {args.shape} {width}x{height} · "
                  f"{args.seconds:.0f}초 · {total}프레임")
            page.goto(url, wait_until="load", timeout=300000)
            page.wait_for_function(
                "() => window.__HORMUZ_RTS__?.battle?.initialized === true", timeout=300000)

            page.evaluate(HIDE_CURSOR)
            page.evaluate("() => window.__HORMUZ_RTS__.start()")
            page.evaluate("() => window.__HORMUZ_RTS__.setAutoBattle(true)")
            page.wait_for_timeout(1200)      # 시작 연출이 자리잡을 시간
            page.evaluate(INSTALL_FILM)

            # 교전이 붙기 전은 심심하다. 그만큼 흘려보내고 담기 시작한다.
            for _ in range(round(args.warmup * args.fps)):
                page.evaluate("(dt) => window.__GAMEFILM__.step(dt)", 1 / args.fps)

            for index in range(total):
                page.evaluate("(dt) => window.__GAMEFILM__.step(dt)", 1 / args.fps)
                encoder.stdin.write(page.screenshot(type="jpeg", quality=args.quality))
                written += 1
                if written % (args.fps * 5) == 0:
                    done = written / total
                    spent = time.time() - started
                    print(f"  {written:>4}/{total} · {done*100:>5.1f}% · "
                          f"남은 시간 {(spent/done - spent)/60:>4.1f}분", flush=True)

            state = page.evaluate("""() => ({
              units: window.__HORMUZ_RTS__.battle.units.length,
              triangles: window.__HORMUZ_RTS__.battle.renderer.info.render.triangles,
              calls: window.__HORMUZ_RTS__.battle.renderer.info.render.calls,
              ended: Boolean(window.__HORMUZ_RTS__.battle.ended)
            })""")
            print(f"  유닛 {state['units']} · 삼각형 {state['triangles']:,} · "
                  f"드로우콜 {state['calls']} · 전투종료 {state['ended']}")
            if failures:
                print(f"  화면 오류 {len(failures)}건: {failures[:2]}")
            browser.close()
    finally:
        encoder.stdin.close()
        encoder.wait()

    size_mb = target.stat().st_size / 1024 / 1024 if target.exists() else 0
    print(f"\n{target}")
    print(f"{written}프레임 · {written/args.fps:.1f}초 · {size_mb:.1f}MB · "
          f"{(time.time()-started)/60:.1f}분 걸림")
    return 0


if __name__ == "__main__":
    sys.exit(main())
