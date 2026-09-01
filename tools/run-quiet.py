"""검사·측정 스크립트를 PC 를 붙잡지 않고 돌린다.

왜 필요한가
-----------
이 저장소의 검사기는 헤드리스 크롬으로 three.js 전투 화면을 띄운다. GPU 를 쓸 수
없어 SwiftShader 로 소프트웨어 렌더링을 하는데, SwiftShader 는 논리 프로세서 수만큼
스레드를 깔고 전부 쓴다. 실측하면 브라우저 **하나가** 12스레드 중 7.7~9.1개를
먹는다. 화면을 줄이거나 우선순위를 낮춰도 거의 안 줄어든다. 그래서 검사기를 돌리는
동안 다른 일을 할 수 없었다.

무엇을 하는가
-------------
자식 프로세스로 대상 스크립트를 돌리면서, 거기서 새로 뜨는 크롬을 찾아 **쓸 수 있는
논리 프로세서 자체를 몇 개로 묶고** 우선순위를 낮춘다. 실측값:

    묶은 코어   PC 점유   진행 속도
    제한 없음     76%      1.59배
    4개           29%      0.73배
    3개           23%      0.71배
    2개           16%      0.41배

3개가 값이 좋다. 4개와 속도가 거의 같은데 점유는 더 낮다. 그래서 기본값이 3이다.

건드리는 대상은 **이 명령이 띄운 프로세스의 자손만**이다. 사장님이 따로 열어둔
크롬은 손대지 않는다.

쓰는 법
-------
    python tools/run-quiet.py python tools/validate-rts-scenarios.py --tag 134
    python tools/run-quiet.py --cores 2 python tools/validate-contact-countdown.py
    python tools/run-quiet.py --report python tools/validate-mission-routing.py
"""
import argparse
import subprocess
import sys
import threading
import time

import psutil

LOGICAL = psutil.cpu_count(logical=True) or 4
PHYSICAL = psutil.cpu_count(logical=False) or LOGICAL
TARGET_NAMES = ("chrome", "chromium", "msedge", "node", "python")


def build_mask(cores):
    """서로 다른 물리 코어에 걸치도록 논리 프로세서를 고른다.

    붙어 있는 번호를 그냥 집으면 하이퍼스레드 형제끼리 걸려 실제로는 코어
    절반만 쓰게 된다. 실측에서 [9,10,11] 은 진행 0.54배, 같은 CPU 를 쓰면서
    [11,9,7] 은 0.66배였다. 그래서 형제 간격만큼 띄워 고른다.
    """
    step = max(1, LOGICAL // PHYSICAL)
    picked = [(LOGICAL - 1) - i * step for i in range(cores)]
    picked = [i for i in picked if i >= 0]
    if len(picked) < cores:  # 코어를 많이 달라고 하면 남은 번호로 채운다
        for i in range(LOGICAL - 1, -1, -1):
            if len(picked) >= cores:
                break
            if i not in picked:
                picked.append(i)
    return sorted(picked)


def descendant_pids(root_pid):
    try:
        root = psutil.Process(root_pid)
    except psutil.Error:
        return set()
    pids = {root_pid}
    try:
        for child in root.children(recursive=True):
            pids.add(child.pid)
    except psutil.Error:
        pass
    return pids


class Throttle(threading.Thread):
    """자식 프로세스에 코어 제한과 낮은 우선순위를 계속 걸어준다.

    크롬은 실행 중에도 프로세스를 새로 띄우므로 한 번만 걸어서는 새는 게 생긴다.
    그래서 끝날 때까지 주기적으로 다시 훑는다.
    """

    def __init__(self, root_pid, cores, interval=0.4):
        super().__init__(daemon=True)
        self.root_pid = root_pid
        self.mask = build_mask(cores)
        self.wanted = set(self.mask)
        self.interval = interval
        self.stop_flag = threading.Event()
        self.touched = set()
        self.reapplied = 0
        self.peak_children = 0

    def run(self):
        """한 번만 걸면 안 된다.

        크롬은 시작하면서 자기 프로세스 설정을 다시 잡는다. 실제로 프로세스가
        뜨자마자 코어를 묶었더니 우선순위만 남고 코어 제한은 12개로 되돌아가
        있었다. 그래서 끝날 때까지 매번 확인하고 어긋나 있으면 다시 건다.
        """
        while not self.stop_flag.is_set():
            pids = descendant_pids(self.root_pid)
            self.peak_children = max(self.peak_children, len(pids))
            for pid in pids:
                try:
                    proc = psutil.Process(pid)
                    name = (proc.name() or "").lower()
                    if not any(tag in name for tag in TARGET_NAMES):
                        continue
                    if set(proc.cpu_affinity()) != self.wanted:
                        proc.cpu_affinity(self.mask)
                        self.reapplied += 1
                    if pid not in self.touched:
                        proc.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
                        self.touched.add(pid)
                except psutil.Error:
                    # 이미 죽었거나 손댈 수 없는 프로세스는 넘어간다.
                    continue
            self.stop_flag.wait(self.interval)

    def verify(self):
        """지금 살아 있는 자손들이 실제로 묶여 있는지 본다."""
        ok, bad = 0, []
        for pid in descendant_pids(self.root_pid):
            try:
                proc = psutil.Process(pid)
                name = (proc.name() or "").lower()
                if not any(tag in name for tag in TARGET_NAMES):
                    continue
                if set(proc.cpu_affinity()) == self.wanted:
                    ok += 1
                else:
                    bad.append(f"{proc.name()}({len(proc.cpu_affinity())}코어)")
            except psutil.Error:
                continue
        return ok, bad


def main():
    parser = argparse.ArgumentParser(
        description="검사 스크립트를 CPU 를 적게 쓰며 실행합니다.",
        usage="python tools/run-quiet.py [--cores N] [--report] <명령> [인자...]",
    )
    parser.add_argument("--cores", type=int, default=3,
                        help="쓸 논리 프로세서 수 (기본 3)")
    parser.add_argument("--report", action="store_true",
                        help="끝난 뒤 실제 점유를 요약해서 보여줍니다")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    sys.stdout.reconfigure(encoding="utf-8")
    if not args.command:
        parser.print_help()
        return 2
    cores = max(1, min(LOGICAL, args.cores))

    print(f"[run-quiet] 논리 프로세서 {LOGICAL}개(물리 {PHYSICAL}개) 중 "
          f"{build_mask(cores)} 번으로 묶어서 실행합니다.")
    print(f"[run-quiet] {' '.join(args.command)}\n", flush=True)

    started = time.time()
    child = subprocess.Popen(args.command)
    throttle = Throttle(child.pid, cores)
    throttle.start()

    samples = []
    checks = []
    if args.report:
        def sample():
            while not throttle.stop_flag.is_set():
                samples.append(psutil.cpu_percent(interval=1.0))
                # 중간에 실제로 묶여 있는지도 같이 본다. 걸었다고 믿지 않는다.
                if len(samples) % 5 == 0:
                    checks.append(throttle.verify())
        threading.Thread(target=sample, daemon=True).start()

    code = child.wait()
    throttle.stop_flag.set()
    elapsed = time.time() - started

    print(f"\n[run-quiet] 종료 코드 {code} · {elapsed:.0f}초 걸림")
    if args.report and samples:
        print(f"[run-quiet] 실행 중 PC 전체 CPU 평균 {sum(samples) / len(samples):.0f}% "
              f"· 최고 {max(samples):.0f}%")
        print(f"[run-quiet] 묶어둔 프로세스 {len(throttle.touched)}개 "
              f"· 되돌려져 다시 건 횟수 {throttle.reapplied}회")
        stuck = [c for c in checks if c[1]]
        if stuck:
            print(f"[run-quiet] ⚠ 안 묶인 프로세스가 보였습니다: {stuck[-1][1]}")
        elif checks:
            print("[run-quiet] 확인한 시점마다 자손 프로세스가 모두 묶여 있었습니다.")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
