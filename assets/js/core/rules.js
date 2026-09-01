import { computeScore } from "./scoring.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const DIAL_KEYS = new Set(["transit", "oil", "approval", "intl", "ammo", "esc"]);
export const MIN_SUCCESS_DAY = 12;
export const MAX_CAMPAIGN_DAY = 54;

export function applyDelta(state, delta = {}) {
  for (const [key, raw] of Object.entries(delta)) {
    const value = Number(raw) || 0;
    if (DIAL_KEYS.has(key)) state.dials[key] += value;
    else if (key === "stability") state.iran.stability += value;
    else if (key === "missiles") state.iran.missiles += value;
    else if (key === "budget") state.politics.authorizedBudget += value;
    else if (key === "party") state.politics.partySupport += value;
    else if (key === "congress") state.politics.congressSupport += value;
  }
  state.dials.transit = clamp(state.dials.transit, 0, 100);
  state.dials.oil = clamp(state.dials.oil, 40, 300);
  state.dials.approval = clamp(state.dials.approval, 0, 100);
  state.dials.intl = clamp(state.dials.intl, 0, 100);
  state.dials.ammo = clamp(state.dials.ammo, 0, 100);
  state.dials.esc = clamp(state.dials.esc, 1, 5);
  state.iran.stability = clamp(state.iran.stability, 0, 100);
  state.iran.missiles = clamp(state.iran.missiles, 0, 100);
  state.politics.authorizedBudget = clamp(state.politics.authorizedBudget, 0, 10000);
  state.politics.partySupport = clamp(state.politics.partySupport, 0, 100);
  state.politics.congressSupport = clamp(state.politics.congressSupport, 0, 100);
  state.maxEsc = Math.max(state.maxEsc, state.dials.esc);
}

export function resolveDay(state) {
  const marketPressure = Math.max(0, Math.round((55 - state.dials.transit) / 14));
  const escalationPressure = Math.max(0, state.dials.esc - 3);
  state.dials.oil = clamp(state.dials.oil + marketPressure + escalationPressure, 40, 300);
  if (state.dials.transit < 35) state.dials.approval = clamp(state.dials.approval - 1, 0, 100);
  if (state.dials.esc >= 4) state.dials.intl = clamp(state.dials.intl - 1, 0, 100);
  state.dials.ammo = clamp(state.dials.ammo + 1, 0, 100);

  state.flags.lowApprovalDays = state.dials.approval < 30 ? state.flags.lowApprovalDays + 1 : 0;
  if (state.iran.stability <= 35) {
    state.iran.stance = "DESPERATE";
    state.flags.desperateDays++;
  } else if (state.dials.esc <= 2 || state.flags.ceasefire) {
    state.iran.stance = "PRAGMATIC";
    state.flags.desperateDays = 0;
  } else {
    state.iran.stance = "HARDLINE";
    state.flags.desperateDays = 0;
  }

  if (state.negotiation.open || state.day >= 36) state.act = "EXIT";
  else if (state.dials.esc >= 4) state.act = "REIGNITE";
  else if (state.day >= 8) state.act = "ATTRITION";
  else state.act = "LULL";
}

export function checkTerminalEnding(state) {
  // 첫 11일은 어떤 수치가 한계에 닿아도 즉시 엔딩으로 끊지 않는다.
  // 위기 수치는 다음 날의 선택과 이란 대응을 바꾸는 압력으로 남고,
  // 승리·실패를 포함한 최종 판정은 DAY 12부터 가능하다.
  if (state.day < MIN_SUCCESS_DAY) return null;
  if (state.dials.esc >= 5) return "gulf_war_three";
  if (state.dials.oil > 200) return "oil_collapse";
  if (state.flags.lowApprovalDays >= 2) return "lame_duck";
  if (state.iran.stability <= 0 && state.day >= MIN_SUCCESS_DAY) return "tehran_winter";
  if (state.flags.desperateDays >= 3) return "ten_warheads";
  if (state.day >= MAX_CAMPAIGN_DAY) return "endless_war";
  return null;
}

export function negotiationPower(state) {
  return Math.round(
    state.dials.transit * 0.3 +
    (100 - state.iran.stability) * 0.3 +
    state.dials.ammo * 0.2 +
    state.dials.intl * 0.2 +
    (state.flags.guarantee ? 20 : 0)
  );
}

export function negotiationDemand(terms, state) {
  const costs = [8, 18, 30];
  return terms.reduce((sum, term) => sum + costs[clamp(term, 0, 2)], 0) - (state.flags.reconstruction ? 10 : 0);
}

export function resolveNegotiation(state, terms) {
  const power = negotiationPower(state);
  const demand = negotiationDemand(terms, state);
  const dayLocked = state.day < MIN_SUCCESS_DAY;
  const success = !dayLocked && state.iran.stance !== "DESPERATE" && power >= demand;
  return {
    success,
    power,
    demand,
    dayLocked,
    near: !dayLocked && !success && state.iran.stance !== "DESPERATE" && demand - power <= 15
  };
}

export function negotiatedEndingId(state, terms) {
  const hard = terms.filter((value) => value === 2).length;
  const soft = terms.filter((value) => value === 0).length;
  if (state.day < MIN_SUCCESS_DAY) return null;
  if (state.flags.ceasefire && state.dials.transit >= 75 && state.maxEsc <= 3) return "calm_hold";
  if (state.day <= 18 && state.dials.transit >= 85 && state.maxEsc <= 3) return "short_war";
  if (state.dials.intl >= 70 && hard >= 1 && soft <= 2) return "hormuz_accord";
  return "uneasy_truce";
}

export function finalizeEnding(state, endingId, endings) {
  const ending = endings.find((item) => item.id === endingId) || endings.find((item) => item.id === "endless_war");
  const score = computeScore({
    endDay: Math.max(1, state.day),
    endingId: ending.id,
    endingGrade: ending.grade,
    oil: state.dials.oil,
    approval: state.dials.approval,
    intl: state.dials.intl,
    transit: state.dials.transit,
    maxEsc: state.maxEsc
  });
  state.phase = "ENDING";
  state.ended = {
    endingId: ending.id,
    name: ending.name,
    nameEn: ending.nameEn || "",
    tagline: ending.tagline,
    taglineEn: ending.taglineEn || "",
    grade: ending.grade,
    endDay: Math.max(1, state.day),
    score: score.total,
    parts: score.parts,
    seed: state.seed
  };
  return state.ended;
}
