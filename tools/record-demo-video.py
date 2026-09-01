"""호르무즈 플레이 데모 영상 자동 녹화기.

마케팅브레인의 `tools/asset_demo_video.py` 가 쓰는 Playwright 네이티브 녹화
(`record_video_dir`)를 그대로 가져오되, 시연 방식만 바꿨다.

★ 마케팅브레인의 범용 드라이버(보이는 버튼 아무거나 클릭)는 여기에 맞지 않는다.
  호르무즈는 결정 카드를 아무거나 누르면 흐름이 엉키고, 전투는 부대를 실제로
  움직여야 그림이 나온다. 그래서 화면별 전용 대본(SCENES)을 따라 진행한다.

기본 대본
  1) 타이틀 화면          — 게임 이름과 분위기를 보여준다
  2) 과거 사건 선택       — 선택지를 훑고 하나 고른다
  3) 첫 전투 편성         — 전력 편성 화면
  4) 전투                — 전 부대 선택 → 공격 이동 → 교전
  5) 결과·상황실 복귀     — 결과 화면

사용
    python -X utf8 tools/record-demo-video.py                     # 가로 1600x900
    python -X utf8 tools/record-demo-video.py --shape portrait    # 세로 1080x1920 (쇼츠·릴스)
    python -X utf8 tools/record-demo-video.py --lang en --shape portrait
    python -X utf8 tools/record-demo-video.py --base https://sidak.kr/autodev/GameCreator/hormuz

결과: output/promo/hormuz-demo-<lang>-<shape>.webm
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


def find_ffmpeg():
    """PATH 와 WinGet 설치 경로에서 ffmpeg 를 찾는다. 없으면 None."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    packages = Path.home() / "AppData/Local/Microsoft/WinGet/Packages"
    if packages.exists():
        for candidate in packages.glob("Gyan.FFmpeg*/**/bin/ffmpeg.exe"):
            return str(candidate)
    return None


def post_process(ffmpeg, source, trim_seconds, make_mp4, notes):
    """앞부분 부팅 구간을 잘라내고, 업로드용 MP4 를 함께 만든다.

    녹화는 페이지가 열리는 순간부터 돌아가므로 첫 몇 초는 사전이 적용되기 전
    화면이다. 그 구간을 잘라야 영상이 제목부터 깔끔하게 시작한다.
    """
    outputs = {"webm": str(source)}
    if not ffmpeg:
        notes.append("ffmpeg 없음 — 원본 webm 만 남긴다")
        return outputs

    if trim_seconds > 0.4:
        trimmed = source.with_name(source.stem + "-trimmed.webm")
        run = subprocess.run(
            [ffmpeg, "-v", "error", "-y", "-ss", f"{trim_seconds:.2f}",
             "-i", str(source), "-c:v", "libvpx-vp9", "-b:v", "3M",
             "-cpu-used", "4", "-row-mt", "1", "-an", str(trimmed)],
            capture_output=True, text=True)
        if run.returncode == 0 and trimmed.exists():
            source.unlink()
            trimmed.rename(source)
            notes.append(f"도입 {trim_seconds:.1f}초 잘라냄")
        else:
            notes.append(f"트림 실패 — 원본 유지 ({run.stderr[:80]})")

    if make_mp4:
        mp4 = source.with_suffix(".mp4")
        run = subprocess.run(
            [ffmpeg, "-v", "error", "-y", "-i", str(source),
             "-c:v", "libx264", "-preset", "medium", "-crf", "21",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", str(mp4)],
            capture_output=True, text=True)
        if run.returncode == 0 and mp4.exists():
            outputs["mp4"] = str(mp4)
            notes.append(f"MP4 변환 {mp4.stat().st_size:,} 바이트")
        else:
            notes.append(f"MP4 변환 실패 ({run.stderr[:80]})")
    return outputs

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "output" / "promo"

# 화면비. 가로는 레딧·유튜브, 세로는 쇼츠·릴스·스레드용이다.
SHAPES = {
    "landscape": {"width": 1600, "height": 900},
    "portrait": {"width": 1080, "height": 1920},
    "square": {"width": 1080, "height": 1080},
    # ★ 실제 폰 화면. 폭이 430px 이어야 폰 전용 규칙(@media max-width:850px)을 탄다.
    #   1080x1920 은 '세로로 긴 데스크톱' 이라 폰 배치가 나오지 않는다.
    #   화소가 모자라지 않게 2배로 그려 담는다(430x932 를 860x1864 로 기록).
    "phone": {"width": 430, "height": 932, "scale": 2},
}

# 시연 전체 상한. 넘기면 남은 장면을 건너뛰고 정상 종료한다.
TOTAL_BUDGET_SECONDS = 190


class Director:
    """대본을 순서대로 실행하고, 각 장면이 예산을 넘지 않게 관리한다."""

    def __init__(self, page, deadline, verbose=True):
        self.page = page
        self.deadline = deadline
        self.verbose = verbose
        self.log = []
        self.intro_ready_at = None      # 사전이 적용돼 촬영을 시작해도 되는 시각

    def over(self):
        return time.time() > self.deadline

    def grant(self, seconds):
        """로딩 대기는 연출이 아니라 기다림이다. 그만큼 예산을 되돌려 준다."""
        self.deadline += seconds

    def wait_for(self, probe, limit, label):
        """조건이 참이 될 때까지 기다리고, 기다린 만큼 예산을 돌려준다."""
        started = time.time()
        while time.time() - started < limit:
            try:
                if probe():
                    waited = time.time() - started
                    self.grant(waited)
                    self.note(f"{label} 준비 {waited:.1f}초")
                    return True
            except Exception:
                pass
            self.page.wait_for_timeout(500)
        self.grant(limit)
        self.note(f"{label} 대기 시간 초과 ({limit}초)")
        return False

    def beat(self, name, seconds):
        """장면 사이의 '감상 시간'. 관객이 화면을 읽을 틈을 준다."""
        if self.over():
            return
        self.page.wait_for_timeout(int(seconds * 1000))
        self.note(f"{name} · {seconds}초 감상")

    def note(self, message):
        self.log.append(message)
        if self.verbose:
            print(f"    {message}", flush=True)

    def click_when(self, selector, timeout=15000, label=None):
        """보이고 눌릴 수 있을 때 실제 포인터로 누른다.

        HUD 는 pointer-events:none 인 곳이 있어 합성 클릭은 실제 동작을
        보증하지 못한다. 좌표로 눌러 실제와 같은 경로를 탄다.

        ★ 누르기 전에 화면 안으로 굴려 넣는다.
          전투 편성 카드는 1600x900 에서 세로로 넘쳐 시작 버튼이 y=1121 에 있다.
          좌표 클릭은 자동 스크롤을 하지 않으므로 그냥 누르면 허공을 친다.
        """
        if self.over():
            return False
        try:
            element = self.page.wait_for_selector(selector, state="visible", timeout=timeout)
            # ★ 스크롤은 보조 수단이다. 실패해도 클릭을 포기하지 않는다.
            #   scroll_into_view_if_needed 는 요소가 '멈출' 때까지 기다리는데,
            #   타이틀 화면은 24초짜리 배경 애니메이션이 계속 돌아 영영 멈추지 않는다.
            #   그래서 화면에 멀쩡히 보이는 버튼을 못 눌러 영상이 타이틀에서 멈췄다.
            try:
                element.scroll_into_view_if_needed(timeout=2500)
                self.page.wait_for_timeout(600)      # 스크롤이 멎을 틈
            except Exception:
                self.note(f"스크롤 생략 {label or selector} (화면이 계속 움직임)")
            box = element.bounding_box()
            if not box:
                self.note(f"건너뜀 {label or selector} (위치 없음)")
                return False
            centre_y = box["y"] + box["height"] / 2
            height = self.page.evaluate("() => window.innerHeight")
            if centre_y < 0 or centre_y > height:
                self.note(f"건너뜀 {label or selector} (화면 밖 y={centre_y:.0f})")
                return False
            self.page.mouse.click(box["x"] + box["width"] / 2, centre_y)
            self.note(f"클릭 {label or selector}")
            return True
        except Exception:
            self.note(f"건너뜀 {label or selector} (없음)")
            return False

    def exists(self, selector):
        try:
            return self.page.evaluate(
                "(s) => { const e = document.querySelector(s);"
                " return !!e && e.getBoundingClientRect().width > 0; }", selector)
        except Exception:
            return False


def drive_title(director, click_start=True):
    """타이틀 화면 — 이름과 분위기를 보여주고 시작한다.

    ★ 문구 사전이 적용된 뒤에 촬영을 시작한다.
      HTML 정적 기본값은 영어(HORMUZ)이고 사전이 오면 한국어(호르무즈)로 바뀐다.
      그 전에 찍으면 영상 첫 장면에서 제목이 바뀌는 장면이 그대로 남는다.
    """
    page = director.page
    # 사전이 실제로 적용돼 제목이 그 언어의 표기가 된 뒤에 찍는다.
    # 그 시각을 기록해 두었다가 녹화가 끝나면 그 앞을 잘라낸다.
    ready_js = """() => {
      const start = document.querySelector('#start-game');
      const heading = document.querySelector('#title-game-name');
      if (!start || start.disabled || !heading) return false;
      const lang = document.documentElement.lang;
      return lang !== 'ko' || heading.textContent.trim() !== 'HORMUZ';
    }"""
    director.wait_for(lambda: page.evaluate(ready_js), 60, "문구·시작 버튼")
    director.intro_ready_at = time.time()
    director.beat("타이틀", 5.0)
    if not click_start:
        # 작전 화면만 담는 판에서는 여기서 누르지 않는다. 누르면 도입 전투로
        # 넘어가고, 곧바로 작전 화면으로 이동하면 전투 로딩 화면이 한 번 스친다.
        return
    director.click_when("#start-game", label="새 작전 시작")


def drive_history(director, picks=3):
    """과거 사건 — 선택지를 훑어보고 고른다. 화면 변화를 만드는 구간이다.

    ★ 전투가 딸리지 않은 선택지를 고른다.
      과거 구간의 전투는 본편 월드가 살아 있는 채로 iframe 안에서 또 하나의
      WebGL 컨텍스트를 띄운다. 녹화 중에는 그 둘이 겹쳐 초기화가 몇 분씩 걸린다.
      전투는 뒤에서 단독 화면으로 따로 찍는 편이 화질도 속도도 낫다.
      타임라인 앞 세 단계는 마지막 선택지가 전투 없는 외교·경제 안이다.
    """
    page = director.page
    for step in range(picks):
        if director.over():
            return
        try:
            page.wait_for_selector("[data-replay]", state="visible", timeout=25_000)
        except Exception:
            director.note("과거 사건 화면 없음 — 건너뜀")
            return
        director.beat(f"과거 사건 {step + 1} 읽기", 3.0)

        options = page.query_selector_all("[data-replay]")
        if not options:
            return

        # 선택지 위로 마우스를 훑어 어떤 카드들이 있는지 보여준다.
        for option in options[:3]:
            if director.over():
                break
            box = option.bounding_box()
            if box:
                page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                page.wait_for_timeout(650)

        target = options[-1]          # 전투가 없는 쪽
        box = target.bounding_box()
        if box:
            page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            director.note(f"과거 사건 {step + 1} 선택")
        director.beat("선택 결과", 3.2)

        if director.exists(".embedded-rts-frame"):
            director.note("전투가 딸린 선택 — 과거 구간 종료")
            return
        if director.exists("#next-history"):
            director.click_when("#next-history", label="다음 사건")


def wait_for_decision(director, index, limit=75):
    """결정 패널이 올라올 때까지 기다리되, 앞을 막는 브리핑 모달은 읽고 넘긴다.

    ★ 자동 진행(`ui.auto`)을 끄면 일일 브리핑·대통령 발언 모달이 사람의 클릭을
      기다린다. 자동 모드에서는 그것들을 통째로 건너뛰기 때문에 안 보이던 화면이다.
      촬영에서는 그 모달도 게임의 일부이므로 잠깐 보여준 뒤 넘긴다.
    """
    page = director.page
    started = time.time()
    while time.time() - started < limit:
        try:
            state = page.evaluate("""() => {
              const panel = document.querySelector('#decision-panel');
              const modal = document.querySelector('#modal-layer');
              return {
                decision: !!panel && panel.classList.contains('open')
                          && panel.querySelectorAll('.decision-card').length > 0,
                modal: modal ? modal.childElementCount : 0,
                battle: !!document.querySelector('.embedded-rts-shell'),
              };
            }""")
        except Exception:
            page.wait_for_timeout(400)
            continue

        if state["decision"]:
            waited = time.time() - started
            director.grant(waited)
            director.note(f"결정 {index} 준비 {waited:.1f}초")
            return True

        if state["battle"]:
            # 작전 중 전투가 시작됐다. 전투는 단독 화면으로 따로 찍으므로
            # 여기서 더 기다리지 않는다. 기다리면 빈 화면만 길게 남는다.
            director.note("작전 중 전투 시작 — 작전 구간 종료")
            return False

        if state["modal"]:
            director.beat("브리핑 읽기", 2.6)
            buttons = page.query_selector_all("#modal-layer button")
            if buttons:
                box = buttons[-1].bounding_box()
                if box:
                    page.mouse.click(box["x"] + box["width"] / 2,
                                     box["y"] + box["height"] / 2)
                    director.note("브리핑 넘김")
            page.wait_for_timeout(700)
            continue

        page.wait_for_timeout(400)

    director.grant(limit)
    director.note(f"결정 {index} 대기 시간 초과 ({limit}초)")
    return False


def drive_campaign(director, lang, base, google, rounds=3):
    """본편 작전 화면 — 지도 위에서 하루의 결정을 내리는 구간.

    이 게임의 대부분은 이 화면이다. 지표를 읽고, 선택지 셋 중 하나를 고르고,
    그 결과가 지표에 어떻게 반영됐는지 확인하는 것이 한 사이클이다.
    영상에서도 그 사이클이 보여야 무슨 게임인지 전달된다.

    ★ 전투 화면과 같은 이유로 작전 화면에도 직접 들어간다.
      정식 흐름은 역사 6단계를 고른 뒤 도입 전투를 치러야 작전 화면이 열린다.
      녹화에서 그 경로를 타면 WebGL 컨텍스트가 둘 겹쳐 몇 분씩 걸리고,
      전투는 어차피 뒤에서 단독 화면으로 따로 찍는다.

    ★ 결정 패널은 화면 밖에 숨어 있다가 `.open` 이 붙으면서 올라온다.
      나타나자마자 누르면 슬라이드 도중이라 좌표가 어긋난다. 올라온 뒤 누른다.
    """
    page = director.page
    url = (f"{base}/index.html?debug=fast&autostart=1&prologue=complete"
           f"&startMode=new&timeline=complete&lang={lang}&google={google}")

    # ★ 자동 진행은 페이지가 뜨기 전에 꺼야 한다.
    #   작전 화면은 진입하는 순간 이미 첫 결정 패널이 열려 있다. 진입한 뒤에 끄면
    #   그 사이 자동 처리가 끝나 전투로 넘어가고, 정작 결정 화면은 한 장도 안 찍힌다.
    #   `__HORMUZ__` 가 만들어지는 즉시 끄도록 문서 로드 전에 심어 둔다.
    page.add_init_script("""
      (() => {
        const timer = setInterval(() => {
          const d = window.__HORMUZ__ && window.__HORMUZ__.director;
          if (!d || !d.ui) return;
          d.ui.auto = false;
          d.fast = false;
          clearInterval(timer);
        }, 25);
      })();
    """)
    page.goto(url, wait_until="load", timeout=90_000)

    ready = """() => !!(window.__HORMUZ__ && window.__HORMUZ__.state.day > 0)"""
    if not director.wait_for(lambda: page.evaluate(ready), 90, "작전 화면"):
        director.note("작전 화면 진입 실패 — 건너뜀")
        return

    # ★ 여기서 시계를 사람 속도로 되돌린다.
    #   작전 화면에 닿으려면 debug=fast 가 필요한데(정상 흐름은 도입 전투를 거쳐야 한다),
    #   그 모드는 `ui.auto` 가 켜져 결정을 사람 대신 즉시 처리해 버린다.
    #   그대로 찍으면 선택지가 뜨자마자 사라져 아무것도 담기지 않는다.
    #   화면 배치와 규칙은 그대로고, 결정을 기다려 주게만 바꾼다.
    try:
        state = page.evaluate("""() => {
          const d = window.__HORMUZ__.director;
          if (d && d.ui) d.ui.auto = false;
          if (d) d.fast = false;
          return d && d.ui ? d.ui.auto : null;
        }""")
        director.note(f"자동 진행 해제 확인 (auto={state})")
    except Exception:
        director.note("자동 진행 해제 실패 — 그대로 진행")

    director.beat("작전 상황판", 2.0)

    for step in range(rounds):
        if director.over():
            return
        opened = wait_for_decision(director, step + 1, limit=50)
        if not opened:
            director.note("결정 패널이 뜨지 않음 — 작전 구간 종료")
            return
        page.wait_for_timeout(700)          # 슬라이드가 멎을 틈
        director.beat(f"선택지 {step + 1} 읽기", 2.4)

        cards = page.query_selector_all("#decision-panel .decision-card")
        if not cards:
            director.note("선택지가 없다 — 작전 구간 종료")
            return
        # 세 장을 차례로 짚어 무엇을 고르는 화면인지 보여준다.
        for card in cards[:3]:
            if director.over():
                break
            box = card.bounding_box()
            if box:
                page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                page.wait_for_timeout(700)

        target = cards[step % len(cards)]
        box = target.bounding_box()
        if box:
            page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            director.note(f"결정 {step + 1} 선택")
        # 선택 결과 패널이 뜬다. 7.6초 뒤 스스로 사라지므로 그 사이를 담는다.
        director.beat("선택 결과", 4.6)

        # 결정이 작전 중 전투로 이어지면 여기서 끊는다. 전투는 단독 화면으로
        # 따로 찍는 편이 화질도 속도도 낫다(본편 월드와 WebGL 컨텍스트가 겹친다).
        if director.exists(".embedded-rts-shell"):
            director.note("전투로 이어짐 — 작전 구간 종료")
            return


def drive_battle(director, scenario, lang, base, google, hud="1"):
    """전투 — 단독 화면으로 진입해 편성을 보여주고, 부대를 움직여 교전을 만든다.

    본편 안 iframe 이 아니라 전투 페이지로 직접 들어간다. WebGL 컨텍스트가
    하나뿐이라 녹화 중에도 8초 안팎에 준비되고, 화면도 가장자리 잘림 없이 꽉 찬다.
    """
    page = director.page
    url = (f"{base}/rts-combat.html?scenario={scenario}"
           f"&lang={lang}&google={google}&campaign=demo&hud={hud}")
    page.goto(url, wait_until="load", timeout=90_000)
    frame = page

    def engine_ready():
        return frame.evaluate("() => !!(window.__HORMUZ_RTS__ "
                              "&& window.__HORMUZ_RTS__.getSnapshot().initialized)")

    if not director.wait_for(engine_ready, 90, "전투 엔진"):
        director.note("엔진 초기화 실패 — 건너뜀")
        return

    director.beat("전력 편성 화면", 3.5)
    # 편성 카드를 천천히 훑어 어떤 전력을 고르는 화면인지 보여준다.
    try:
        page.mouse.wheel(0, 320)
        page.wait_for_timeout(1400)
        director.note("편성 카드 훑기")
    except Exception:
        pass

    # 편성 화면의 시작 버튼. 반드시 #start-battle 을 집는다.
    # 같은 화면의 첫 버튼을 집으면 '의회 추가예산' 버튼이 눌려 예산 모달로 빠진다.
    started = director.click_when("#start-battle", label="작전 시작")
    if started:
        # 편성 레이어가 실제로 걷혔는지 확인한다. 눌렸다는 로그만 믿지 않는다.
        director.wait_for(
            lambda: frame.evaluate("() => window.__HORMUZ_RTS__.getSnapshot().started"),
            15, "전투 개시")
    if not started:
        try:
            frame.evaluate("() => window.__HORMUZ_RTS__.start()")
            director.note("작전 시작 (API)")
        except Exception:
            director.note("전투 시작 실패")
            return

    director.beat("전장 진입", 3.0)

    # 전 부대 선택 → 적으로 공격 이동. 실제 조작처럼 보이게 순서를 지킨다.
    try:
        frame.evaluate("() => window.__HORMUZ_RTS__.selectAll()")
        director.note("전 부대 선택")
    except Exception:
        pass
    director.beat("선택 표시", 1.6)

    try:
        frame.evaluate("() => window.__HORMUZ_RTS__.attackAll()")
        director.note("공격 이동 명령")
    except Exception:
        try:
            frame.evaluate("() => window.__HORMUZ_RTS__.assault()")
            director.note("돌격 명령")
        except Exception:
            pass

    # 교전이 붙는 동안 지켜본다. 전투가 먼저 끝나면 즉시 빠져나온다.
    watched = 0
    while watched < 34 and not director.over():
        page.wait_for_timeout(2000)
        watched += 2
        try:
            if frame.evaluate("() => window.__HORMUZ_RTS__.getSnapshot().ended"):
                director.note(f"전투 종료 감지 ({watched}초 교전)")
                break
        except Exception:
            break
    director.note(f"교전 {watched}초 촬영")
    director.beat("결과 화면", 5.0)


def build_scenes(scenario, lang, base, google, hud, only=""):
    scenes = [
        ("타이틀", lambda d: drive_title(d, click_start=(only != "campaign"))),
        ("과거 사건", drive_history),
        ("작전", lambda d: drive_campaign(d, lang, base, google)),
        ("전투", lambda d: drive_battle(d, scenario, lang, base, google, hud)),
    ]
    if only == "campaign":
        # 작전 화면만 담는 판. 역사 구간은 도입 전투로 이어져 여기서는 건너뛴다.
        return [s for s in scenes if s[0] in ("타이틀", "작전")]
    if only == "battle":
        return [s for s in scenes if s[0] in ("타이틀", "전투")]
    return scenes


def record(base, lang, shape, google, scenario, out_name, trim=True, mp4=True,
           hud="1", only=""):
    spec = SHAPES[shape]
    size = {"width": spec["width"], "height": spec["height"]}
    scale = spec.get("scale", 1)
    OUT.mkdir(parents=True, exist_ok=True)
    tmp_dir = OUT / "_video_tmp"
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir, ignore_errors=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    report = {"base": base, "lang": lang, "shape": shape, "size": size,
              "scale": scale, "scenes": []}
    started_at = time.time()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
            "--hide-scrollbars",
            "--mute-audio",
        ])
        context = browser.new_context(
            viewport=size,
            device_scale_factor=scale,
            record_video_dir=str(tmp_dir),
            record_video_size={"width": size["width"] * scale,
                               "height": size["height"] * scale},
        )
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        recording_started = time.time()

        # autostart 를 쓰지 않는다. 그 파라미터는 타이틀 화면을 건너뛰는데,
        # 데모 영상에서는 타이틀이 첫 장면이라 반드시 보여야 한다.
        url = f"{base}/index.html?lang={lang}&google={google}"
        page.goto(url, wait_until="load", timeout=90_000)

        director = Director(page, time.time() + TOTAL_BUDGET_SECONDS)
        for name, scene in build_scenes(scenario, lang, base, google, hud, only):
            if director.over():
                director.note(f"예산 초과 — {name} 이후 생략")
                break
            print(f"  [{name}]", flush=True)
            mark = time.time()
            scene(director)
            report["scenes"].append({"name": name, "seconds": round(time.time() - mark, 1)})

        video = page.video
        context.close()   # close 가 녹화 파일을 확정한다
        # 경로는 playwright 가 살아 있는 동안에만 물을 수 있다. 블록을 벗어나기 전에 받아 둔다.
        video_path = Path(video.path())
        browser.close()

    destination = OUT / out_name
    if destination.exists():
        destination.unlink()
    shutil.move(str(video_path), str(destination))
    shutil.rmtree(tmp_dir, ignore_errors=True)

    notes = []
    trim_seconds = 0.0
    if trim and director.intro_ready_at:
        # 준비 직전 0.6초는 남겨 화면이 뚝 끊긴 느낌이 나지 않게 한다.
        trim_seconds = max(0.0, director.intro_ready_at - recording_started - 0.6)
    outputs = post_process(find_ffmpeg(), destination, trim_seconds, mp4, notes)

    report["outputs"] = outputs
    report["postProcess"] = notes
    report["output"] = str(destination)
    report["bytes"] = destination.stat().st_size
    report["totalSeconds"] = round(time.time() - started_at, 1)
    report["pageErrors"] = errors[:5]
    report["log"] = director.log
    return report


def main():
    parser = argparse.ArgumentParser(description="호르무즈 플레이 데모 영상 녹화")
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--lang", default="ko", choices=["ko", "en"])
    parser.add_argument("--shape", default="landscape", choices=list(SHAPES))
    parser.add_argument("--google", default="0", choices=["0", "1"],
                        help="1이면 Google 3D 지형을 쓴다. 로딩이 길어 녹화가 늘어난다")
    parser.add_argument("--scenario", default="convoy_shield",
                        help="전투 구간에 쓸 시나리오")
    parser.add_argument("--no-trim", action="store_true",
                        help="도입 부팅 구간을 자르지 않는다")
    parser.add_argument("--no-mp4", action="store_true",
                        help="업로드용 MP4 를 만들지 않는다")
    parser.add_argument("--hud", default="1", choices=["1", "0", "none"],
                        help="전투 HUD 표시 — 1 전부, 0 계기 숨김, none 이름표까지 숨김")
    parser.add_argument("--only", default="", choices=["", "campaign", "battle"],
                        help="campaign 이면 작전 화면까지만, battle 이면 전투만 담는다")
    parser.add_argument("--out", default="")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    suffix = "" if args.hud == "1" else f"-hud{args.hud}"
    if args.only:
        suffix += f"-{args.only}"
    out_name = args.out or f"hormuz-demo-{args.lang}-{args.shape}{suffix}.webm"
    print(f"녹화 시작 · {args.lang} · {args.shape} "
          f"{SHAPES[args.shape]['width']}x{SHAPES[args.shape]['height']}")
    report = record(args.base.rstrip("/"), args.lang, args.shape, args.google,
                    args.scenario, out_name,
                    trim=not args.no_trim, mp4=not args.no_mp4, hud=args.hud,
                    only=args.only)

    record_path = OUT / f"{Path(out_name).stem}-report.json"
    record_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n완료 · {report['output']}")
    print(f"  {report['bytes']:,} 바이트 · 촬영 {report['totalSeconds']}초")
    for scene in report["scenes"]:
        print(f"  {scene['name']:10s} {scene['seconds']:>5.1f}초")
    for note in report.get("postProcess", []):
        print(f"  {note}")
    if report.get("outputs", {}).get("mp4"):
        print(f"  업로드용: {report['outputs']['mp4']}")
    if report["pageErrors"]:
        print(f"  페이지 오류: {report['pageErrors'][:2]}")
    print(f"  기록: {record_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
