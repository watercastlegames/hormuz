"""한/영 이중 언어 검증.

1) 사전 정합성 — strings.ko/en 의 키가 정확히 같은지, 영문 사전에 한글이 남았는지.
2) 데이터 이중화 — 화면에 나오는 데이터 JSON에 <필드>En 이 빠진 곳이 있는지.
3) 실화면 — ko/en 두 언어로 실제 화면을 띄워 잔여 한글과 미치환 키를 잡고 캡처한다.

영문 화면에 한글이 남아 있으면 실패한다. 단 한/영 토글 버튼의 "한국어" 표기와
사람 이름·고유명사 같이 의도적으로 남긴 값은 예외 목록으로 관리한다.

사용:
    python -X utf8 tools/validate-i18n.py
    python -X utf8 tools/validate-i18n.py --tag v133
"""

import argparse
import json
import pathlib
import re
import sys

from playwright.sync_api import sync_playwright

REPO = pathlib.Path(__file__).resolve().parent.parent
DATA = REPO / "assets" / "data"
OUT = REPO / "output" / "validation"

KOREAN = re.compile(r"[가-힣]")

# 영문 화면에 남아도 되는 문자열. 언어 토글 라벨은 두 언어 모두에서 모국어로 보여야 한다.
ALLOWED_KOREAN = {"한국어"}

# 데이터 JSON 별로 영문이 반드시 있어야 하는 필드.
REQUIRED_EN = {
    "cards.json": ["name", "desc"],
    "events.json": ["brief", "name", "desc"],
    "endings.json": ["name", "tagline"],
    "timeline.json": ["title", "question", "name", "desc", "summary",
                      "successTitle", "successSummary", "failureTitle", "failureSummary"],
    "missions.json": ["name", "role", "desc", "weapon", "title", "brief"],
    "campaign.json": ["title", "objective", "sector", "politicalStake", "name", "desc"],
    "president_statements.json": ["heading", "line", "context", "sourceLabel"],
}

# 언어별로 확인할 화면. 본편은 타이틀 화면까지만 띄우면 정적 문구가 모두 드러난다.
PAGES = [
    ("title", "index.html?google=0&lang={lang}"),
    ("developer", "developer.html?lang={lang}"),
    ("battle", "rts-combat.html?scenario=convoy_shield&google=0&lang={lang}"),
]

VISIBLE_TEXT_JS = """() => {
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = child.textContent.trim();
        if (text) out.push(text);
        continue;
      }
      if (child.nodeType !== 1 || skip.has(child.tagName)) continue;
      const style = getComputedStyle(child);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (child.hasAttribute("hidden")) continue;
      walk(child);
    }
  };
  walk(document.body);
  ["title", "aria-label", "placeholder"].forEach((attribute) => {
    document.querySelectorAll(`[${attribute}]`).forEach((node) => {
      const value = node.getAttribute(attribute);
      if (value) out.push(value);
    });
  });
  out.push(document.title);
  return out;
}"""


def check_dictionaries():
    ko = json.load(open(DATA / "strings.ko.json", encoding="utf-8"))
    en = json.load(open(DATA / "strings.en.json", encoding="utf-8"))
    problems = []
    only_ko = sorted(set(ko) - set(en))
    only_en = sorted(set(en) - set(ko))
    if only_ko:
        problems.append(f"영문 사전에 없는 키 {len(only_ko)}개: {only_ko[:8]}")
    if only_en:
        problems.append(f"한글 사전에 없는 키 {len(only_en)}개: {only_en[:8]}")
    leftover = sorted(
        key for key, value in en.items()
        if KOREAN.search(str(value)) and str(value) not in ALLOWED_KOREAN
    )
    if leftover:
        problems.append(f"영문 사전에 한글이 남은 키 {len(leftover)}개: {leftover[:8]}")
    print(f"사전 키 {len(ko)}개 · 문제 {len(problems)}건")
    return problems, len(ko)


def check_data_files():
    problems = []
    for name, fields in REQUIRED_EN.items():
        data = json.load(open(DATA / name, encoding="utf-8"))
        missing = []

        def walk(node):
            if isinstance(node, dict):
                for field in fields:
                    korean = node.get(field, node.get(f"{field}Ko"))
                    if isinstance(korean, str) and KOREAN.search(korean):
                        if not node.get(f"{field}En"):
                            missing.append(f"{node.get('id', '?')}/{field}")
                for value in node.values():
                    walk(value)
            elif isinstance(node, list):
                for value in node:
                    walk(value)

        walk(data)
        status = "OK" if not missing else f"누락 {len(missing)}"
        print(f"  [{status:>8}] {name}")
        if missing:
            problems.append(f"{name}: 영문 누락 {missing[:6]}")
    return problems


def check_pages(base, tag):
    OUT.mkdir(parents=True, exist_ok=True)
    problems = []
    report = {}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=[
            "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        ])
        for lang in ("ko", "en"):
            for name, template in PAGES:
                page = browser.new_page(viewport={"width": 1440, "height": 900})
                errors = []
                page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
                page.on("pageerror", lambda e: errors.append(str(e)))
                url = f"{base}/{template.format(lang=lang)}"
                page.goto(url, wait_until="load", timeout=60_000)
                page.wait_for_timeout(9000 if name == "battle" else 5000)

                texts = page.evaluate(VISIBLE_TEXT_JS)
                korean = sorted({
                    text for text in texts
                    if KOREAN.search(text) and text not in ALLOWED_KOREAN
                })
                # 사전에 없는 키는 t()가 키 자체를 돌려주므로 점 표기가 그대로 보인다.
                raw_keys = sorted({
                    text for text in texts
                    if re.fullmatch(r"[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)+", text)
                })
                shot = OUT / f"hormuz-{tag}-i18n-{name}-{lang}-1440x900.jpg"
                page.screenshot(path=str(shot), type="jpeg", quality=80)

                failed = bool(errors) or bool(raw_keys) or (lang == "en" and korean)
                report[f"{name}:{lang}"] = {
                    "url": url,
                    "koreanVisible": korean[:20],
                    "koreanCount": len(korean),
                    "untranslatedKeys": raw_keys[:20],
                    "consoleErrors": errors[:10],
                    "screenshot": str(shot),
                    "passed": not failed,
                }
                mark = "PASS" if not failed else "FAIL"
                print(f"  [{mark}] {name:10s} {lang}  한글 {len(korean):>3}  "
                      f"미치환키 {len(raw_keys):>2}  오류 {len(errors)}")
                if failed:
                    if raw_keys:
                        print(f"          미치환 키: {raw_keys[:6]}")
                    if lang == "en" and korean:
                        print(f"          남은 한글: {korean[:6]}")
                    if errors:
                        print(f"          오류: {errors[:2]}")
                    problems.append(f"{name}:{lang}")
                page.close()
        browser.close()
    return problems, report


def main():
    parser = argparse.ArgumentParser(description="한/영 이중 언어 검증")
    parser.add_argument("--base", default="http://127.0.0.1:8080")
    parser.add_argument("--tag", default="latest")
    parser.add_argument("--skip-pages", action="store_true", help="사전·데이터만 검사")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    print("1. 문구 사전")
    dict_problems, key_count = check_dictionaries()

    print("2. 데이터 이중화")
    data_problems = check_data_files()

    page_problems, report = ([], {})
    if not args.skip_pages:
        print("3. 실화면 (ko/en)")
        page_problems, report = check_pages(args.base.rstrip("/"), args.tag)

    problems = dict_problems + data_problems + page_problems
    record = OUT / f"hormuz-{args.tag}-i18n-validation.json"
    OUT.mkdir(parents=True, exist_ok=True)
    record.write_text(json.dumps({
        "dictionaryKeys": key_count,
        "problems": problems,
        "pages": report,
        "allPassed": not problems,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n기록: {record}")
    if problems:
        for problem in problems:
            print("  문제:", problem)
        return 1
    print("한/영 검증 통과.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
