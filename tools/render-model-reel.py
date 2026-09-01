"""모델 팩 소개 영상을 만든다.

docs/hormuz-model-reel.html 을 열어 **한 프레임씩 손으로 넘기며** 찍는다.
화면 녹화와 다른 점은 프레임이 밀리거나 빠지지 않는다는 것이다.
찍는 속도가 느려도 결과 영상의 시간은 정확하다.

실행:
    python tools/render-model-reel.py --shape 9:16       쓰레드·릴스용 세로
    python tools/render-model-reel.py --shape 16:9       레딧·유튜브용 가로
    python tools/render-model-reel.py --shape 1:1
    python tools/render-model-reel.py --shape 9:16 --depth all    전체 34개

필요한 것: 로컬 웹서버(기본 8080), ffmpeg
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

SIZES = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)}

# 소프트웨어 렌더링은 프레임당 0.5초가 넘는다. 진짜 그래픽카드를 쓰면 6배 빠르다.
GPU_ARGS = ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"]


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
    parser.add_argument("--shape", default="9:16", choices=sorted(SIZES))
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--depth", default="core", choices=("core", "scroll", "all"))
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--out", default="")
    parser.add_argument("--quality", type=int, default=94, help="찍을 때 그림 품질")
    args = parser.parse_args()

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print("ffmpeg 를 찾지 못했다.")
        return 1

    width, height = SIZES[args.shape]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    target = pathlib.Path(args.out) if args.out else (
        OUT_DIR / f"hormuz-model-pack-{args.shape.replace(':', 'x')}-{args.depth}.mp4")

    encoder = subprocess.Popen([
        ffmpeg, "-y", "-loglevel", "error",
        "-f", "image2pipe", "-framerate", str(args.fps), "-i", "-",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
        "-preset", "medium", "-movflags", "+faststart", str(target)
    ], stdin=subprocess.PIPE)

    started = time.time()
    written = 0
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=GPU_ARGS)
            page = browser.new_page(viewport={"width": width, "height": height})
            failures = []
            page.on("pageerror", lambda error: failures.append(str(error)[:120]))

            page.goto(f"{args.base}/docs/hormuz-model-reel.html",
                      wait_until="load", timeout=180000)
            page.wait_for_function("() => Boolean(window.__REEL__)", timeout=180000)

            renderer = page.evaluate("""() => {
              const canvas = document.createElement('canvas');
              const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
              const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
              return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '알 수 없음';
            }""")
            print(f"그리는 장치: {renderer}")

            # 길이 선택은 조작판이 보일 때 해야 한다. 촬영을 시작하면 조작판이 숨는다.
            if args.depth != "core":
                page.select_option("#depth", args.depth)
                page.wait_for_timeout(1500)

            page.evaluate("() => window.__REEL__.film.begin()")
            page.evaluate("([w, h]) => window.__REEL__.film.setSize(w, h)", [width, height])

            scenes = page.evaluate("() => window.__REEL__.scenes()")
            total = sum(round(scene["hold"] * args.fps) for scene in scenes)
            seconds = total / args.fps
            print(f"{args.shape} {width}x{height} · 장면 {len(scenes)}개 · "
                  f"{seconds:.1f}초 · {total}프레임")

            for scene in scenes:
                page.evaluate("(at) => window.__REEL__.goto(at)", scene["at"])
                # 장면이 바뀐 직후 한 번 더 그려서 첫 장이 빈 화면으로 나가지 않게 한다.
                page.evaluate("() => window.__REEL__.film.step(0)")
                frames = round(scene["hold"] * args.fps)
                label = scene["name"]
                if scene["triangles"]:
                    label += f" ({scene['triangles']:,} 삼각형)"

                for _ in range(frames):
                    page.evaluate("(dt) => window.__REEL__.film.step(dt)", 1 / args.fps)
                    encoder.stdin.write(page.screenshot(type="jpeg", quality=args.quality))
                    written += 1

                done = written / total
                spent = time.time() - started
                print(f"  {label:<30} {frames:>3}장 · 전체 {done*100:>5.1f}% · "
                      f"남은 시간 {(spent/max(done, 0.001) - spent)/60:>4.1f}분", flush=True)

            browser.close()
            if failures:
                print(f"  화면 오류 {len(failures)}건: {failures[:2]}")
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
