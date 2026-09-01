export const GRADE_MULT = { "S+": 1.5, S: 1.4, A: 1.25, B: 1.1, C: 1, D: 0.7, E: 0.5, F: 0.3 };
export const NEGOTIATED = new Set(["calm_hold", "short_war", "hormuz_accord", "uneasy_truce"]);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function computeScore(result) {
  // 지표는 델타 누적으로 소수가 될 수 있다. 부분 점수를 정수로 고정해
  // 결과 화면에 106.95000000000007 같은 부동소수가 노출되지 않게 한다.
  const speed = NEGOTIATED.has(result.endingId) ? (19 - clamp(result.endDay, 4, 18)) * 40 : 0;
  const oil = Math.round(clamp(200 - result.oil, 0, 130) * 3);
  const appr = Math.round(clamp(result.approval, 0, 100) * 3);
  const intl = Math.round(clamp(result.intl, 0, 100) * 3);
  const transit = Math.round(clamp(result.transit, 0, 100) * 4);
  const esc = (5 - clamp(result.maxEsc, 1, 5)) * 60;
  const base = speed + oil + appr + intl + transit + esc;
  const total = Math.round(base * (GRADE_MULT[result.endingGrade] ?? 1));
  return { total: clamp(total, 0, 3500), parts: { speed, oil, appr, intl, transit, esc } };
}

export function rankCompare(a, b) {
  return (b.score - a.score) || (a.endDay - b.endDay) || (b.transit - a.transit);
}
