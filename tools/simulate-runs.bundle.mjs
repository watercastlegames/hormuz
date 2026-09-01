// tools/simulate-runs.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";

// assets/js/core/state.js
function freshState(seed = (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0) {
  return {
    version: 2,
    gameId: "hormuz-v1",
    phase: "TITLE",
    lang: "ko",
    seed,
    day: 0,
    act: "LULL",
    dials: { transit: 30, oil: 84, approval: 44, intl: 55, ammo: 45, esc: 3 },
    iran: { stance: "HARDLINE", stability: 40, revealed: false, missiles: 100 },
    stocks: { tomahawk: 14, thaad: 8, spr: 1 },
    maxEsc: 3,
    politics: {
      authorizedBudget: 6e3,
      supplementalBudget: 0,
      spentBudget: 0,
      congressSupport: 39,
      partySupport: 58,
      appropriationsPassed: 0,
      forcedAppropriations: 0
    },
    campaign: {
      prologuePassed: false,
      completedOperations: [],
      failedOperations: [],
      lastBattle: null,
      battleHistory: []
    },
    replay: { choices: [], match: 0 },
    negotiation: { open: false, tries: 3, terms: [1, 1, 1, 1] },
    flags: {
      lowApprovalDays: 0,
      desperateDays: 0,
      history: [],
      introMissionDone: false,
      guarantee: false,
      reconstruction: false,
      ceasefire: false,
      revealed: false
    },
    log: [],
    resume: { stage: "title", day: 0, replayIndex: 0, policy: null, policyStep: 0, eventId: "" },
    user: { displayName: "\uC775\uBA85 \uC0AC\uB839\uAD00", demo: true },
    ended: null
  };
}
var state = freshState();

// assets/js/core/rng.js
function mulberry32(seed) {
  let value = seed >>> 0;
  return function random() {
    value += 1831565813;
    let t = value;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function pick(random, items) {
  return items[Math.floor(random() * items.length)];
}
function shuffle(random, items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

// assets/js/core/policy.js
var MISSION_SCENARIOS = Object.freeze({
  intercept: "missile_screen",
  minesweep: "mine_corridor",
  bombrun: "coastal_battery",
  pickaxe: "pickaxe_mountain",
  bunker: "pickaxe_mountain",
  nuclear: "pickaxe_mountain",
  rescue: "tanker_rescue",
  tanker: "tanker_rescue",
  large: "large_fleet_battle",
  fleet: "large_fleet_battle",
  carrier: "large_fleet_battle"
});
function missionScenarioId(mission) {
  return MISSION_SCENARIOS[mission] || (mission ? "convoy_shield" : "");
}
function recentBattleScenarioIds(state2, limit = 2) {
  const history = Array.isArray(state2?.campaign?.battleHistory) ? state2.campaign.battleHistory : [];
  const ids = history.slice(-limit).map((entry) => entry?.id).filter(Boolean);
  const fallback = state2?.campaign?.lastBattle?.id;
  if (!ids.length && fallback && !String(fallback).startsWith("history_")) ids.push(fallback);
  return ids;
}
var DAILY_DECISION_TRACKS = [
  {
    id: "military",
    cats: ["MIL"],
    title: "\uAD70\uC0AC \uC791\uC804 \uBC29\uCE68",
    subtitle: "\uC624\uB298 \uD22C\uC785\uD560 \uC804\uB825\uACFC \uAD50\uC804 \uC218\uC704\uB97C \uACB0\uC815\uD569\uB2C8\uB2E4.",
    stepLabel: "1/3"
  },
  {
    id: "diplomacy",
    cats: ["DIP"],
    title: "\uC678\uAD50\xB7\uD611\uC0C1 \uBC29\uCE68",
    subtitle: "\uB3D9\uB9F9\uACFC \uC774\uB780\uC5D0 \uBCF4\uB0BC \uC678\uAD50 \uC2E0\uD638\uB97C \uACB0\uC815\uD569\uB2C8\uB2E4.",
    stepLabel: "2/3"
  },
  {
    id: "economy_info",
    cats: ["ECO", "INFO"],
    title: "\uACBD\uC81C\xB7\uC815\uBCF4 \uBC29\uCE68",
    subtitle: "\uC720\uAC00\xB7\uD1B5\uD56D\xB7\uC5EC\uB860\uC744 \uAD00\uB9AC\uD560 \uC870\uCE58\uB97C \uACB0\uC815\uD569\uB2C8\uB2E4.",
    stepLabel: "3/3"
  }
];
function unlocked(card, state2) {
  if (card.unlock?.dayMin && state2.day < card.unlock.dayMin) return false;
  if (card.unlock?.act && !card.unlock.act.includes(state2.act)) return false;
  return true;
}
function curatePolicyTrack(state2, cards2, random, track) {
  const categories = new Set(track?.cats || []);
  const unlockedCards = cards2.filter((card) => categories.has(card.cat) && unlocked(card, state2));
  const recentScenarios = new Set(recentBattleScenarioIds(state2, 2));
  const variedCards = unlockedCards.filter((card) => !card.mission || !recentScenarios.has(missionScenarioId(card.mission)));
  const available = variedCards.length >= 3 ? variedCards : unlockedCards;
  const recent = new Set((state2.flags.history || []).slice(-18));
  const preferred = available.filter((card) => !recent.has(card.id));
  const source = preferred.length >= 3 ? preferred : available;
  const choices = [];
  if (track?.id === "diplomacy") {
    const openChannel = source.find((card) => card.id === "open_channel");
    if (openChannel && state2.day >= 12) choices.push(openChannel);
  }
  if (track?.id === "military") {
    const largeBattle = source.find((card) => card.id === "full_strait_battle");
    if (largeBattle && state2.day >= 11 && state2.act === "ATTRITION") choices.push(largeBattle);
    if (state2.dials.transit < 48) {
      const transitCard = source.filter((card) => (card.delta?.transit || 0) > 6 && !choices.includes(card)).sort((a, b) => (b.delta.transit || 0) - (a.delta.transit || 0))[0];
      if (transitCard) choices.push(transitCard);
    }
  }
  for (const card of shuffle(random, source)) {
    if (!choices.includes(card)) choices.push(card);
    if (choices.length === 3) break;
  }
  return choices.slice(0, 3);
}

// assets/js/core/iran_ai.js
function eventBattleScenarios(event) {
  const scenarios = [];
  if (event?.id === "swarm_approach") scenarios.push("convoy_shield");
  if (event?.mission) scenarios.push(missionScenarioId(event.mission));
  for (const choice of event?.urgent?.choices || []) {
    if (choice.mission) scenarios.push(missionScenarioId(choice.mission));
  }
  return [...new Set(scenarios.filter(Boolean))];
}
function chooseIranEvent(state2, events2, random) {
  const recent = new Set((state2.flags.history || []).slice(-4));
  const recentScenarios = new Set(recentBattleScenarioIds(state2, 2));
  const stancePool = events2.filter((event) => event.stance.includes(state2.iran.stance) && !recent.has(event.id));
  let pool = stancePool.filter((event) => !eventBattleScenarios(event).some((scenario) => recentScenarios.has(scenario)));
  if (!pool.length) pool = stancePool;
  if (!pool.length) pool = events2.filter((event) => event.stance.includes(state2.iran.stance));
  if (!pool.length) pool = events2;
  if (state2.day >= 10 && state2.iran.stance === "PRAGMATIC") {
    const offer = pool.find((event) => event.id === "ceasefire_offer");
    if (offer && random() < 0.55) return offer;
  }
  return pick(random, pool);
}

// assets/js/core/scoring.js
var GRADE_MULT = { "S+": 1.5, S: 1.4, A: 1.25, B: 1.1, C: 1, D: 0.7, E: 0.5, F: 0.3 };
var NEGOTIATED = /* @__PURE__ */ new Set(["calm_hold", "short_war", "hormuz_accord", "uneasy_truce"]);
var clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function computeScore(result) {
  const speed = NEGOTIATED.has(result.endingId) ? (19 - clamp(result.endDay, 4, 18)) * 40 : 0;
  const oil = clamp(200 - result.oil, 0, 130) * 3;
  const appr = clamp(result.approval, 0, 100) * 3;
  const intl = clamp(result.intl, 0, 100) * 3;
  const transit = clamp(result.transit, 0, 100) * 4;
  const esc = (5 - clamp(result.maxEsc, 1, 5)) * 60;
  const base = speed + oil + appr + intl + transit + esc;
  const total = Math.round(base * (GRADE_MULT[result.endingGrade] ?? 1));
  return { total: clamp(total, 0, 3500), parts: { speed, oil, appr, intl, transit, esc } };
}

// assets/js/core/rules.js
var clamp2 = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
var DIAL_KEYS = /* @__PURE__ */ new Set(["transit", "oil", "approval", "intl", "ammo", "esc"]);
var MIN_SUCCESS_DAY = 12;
var MAX_CAMPAIGN_DAY = 54;
function applyDelta(state2, delta = {}) {
  for (const [key, raw] of Object.entries(delta)) {
    const value = Number(raw) || 0;
    if (DIAL_KEYS.has(key)) state2.dials[key] += value;
    else if (key === "stability") state2.iran.stability += value;
    else if (key === "missiles") state2.iran.missiles += value;
    else if (key === "budget") state2.politics.authorizedBudget += value;
    else if (key === "party") state2.politics.partySupport += value;
    else if (key === "congress") state2.politics.congressSupport += value;
  }
  state2.dials.transit = clamp2(state2.dials.transit, 0, 100);
  state2.dials.oil = clamp2(state2.dials.oil, 40, 300);
  state2.dials.approval = clamp2(state2.dials.approval, 0, 100);
  state2.dials.intl = clamp2(state2.dials.intl, 0, 100);
  state2.dials.ammo = clamp2(state2.dials.ammo, 0, 100);
  state2.dials.esc = clamp2(state2.dials.esc, 1, 5);
  state2.iran.stability = clamp2(state2.iran.stability, 0, 100);
  state2.iran.missiles = clamp2(state2.iran.missiles, 0, 100);
  state2.politics.authorizedBudget = clamp2(state2.politics.authorizedBudget, 0, 1e4);
  state2.politics.partySupport = clamp2(state2.politics.partySupport, 0, 100);
  state2.politics.congressSupport = clamp2(state2.politics.congressSupport, 0, 100);
  state2.maxEsc = Math.max(state2.maxEsc, state2.dials.esc);
}
function resolveDay(state2) {
  const marketPressure = Math.max(0, Math.round((55 - state2.dials.transit) / 14));
  const escalationPressure = Math.max(0, state2.dials.esc - 3);
  state2.dials.oil = clamp2(state2.dials.oil + marketPressure + escalationPressure, 40, 300);
  if (state2.dials.transit < 35) state2.dials.approval = clamp2(state2.dials.approval - 1, 0, 100);
  if (state2.dials.esc >= 4) state2.dials.intl = clamp2(state2.dials.intl - 1, 0, 100);
  state2.dials.ammo = clamp2(state2.dials.ammo + 1, 0, 100);
  state2.flags.lowApprovalDays = state2.dials.approval < 30 ? state2.flags.lowApprovalDays + 1 : 0;
  if (state2.iran.stability <= 35) {
    state2.iran.stance = "DESPERATE";
    state2.flags.desperateDays++;
  } else if (state2.dials.esc <= 2 || state2.flags.ceasefire) {
    state2.iran.stance = "PRAGMATIC";
    state2.flags.desperateDays = 0;
  } else {
    state2.iran.stance = "HARDLINE";
    state2.flags.desperateDays = 0;
  }
  if (state2.negotiation.open || state2.day >= 36) state2.act = "EXIT";
  else if (state2.dials.esc >= 4) state2.act = "REIGNITE";
  else if (state2.day >= 8) state2.act = "ATTRITION";
  else state2.act = "LULL";
}
function checkTerminalEnding(state2) {
  if (state2.day < MIN_SUCCESS_DAY) return null;
  if (state2.dials.esc >= 5) return "gulf_war_three";
  if (state2.dials.oil > 200) return "oil_collapse";
  if (state2.flags.lowApprovalDays >= 2) return "lame_duck";
  if (state2.iran.stability <= 0 && state2.day >= MIN_SUCCESS_DAY) return "tehran_winter";
  if (state2.flags.desperateDays >= 3) return "ten_warheads";
  if (state2.day >= MAX_CAMPAIGN_DAY) return "endless_war";
  return null;
}
function negotiationPower(state2) {
  return Math.round(
    state2.dials.transit * 0.3 + (100 - state2.iran.stability) * 0.3 + state2.dials.ammo * 0.2 + state2.dials.intl * 0.2 + (state2.flags.guarantee ? 20 : 0)
  );
}
function negotiationDemand(terms, state2) {
  const costs = [8, 18, 30];
  return terms.reduce((sum, term) => sum + costs[clamp2(term, 0, 2)], 0) - (state2.flags.reconstruction ? 10 : 0);
}
function resolveNegotiation(state2, terms) {
  const power = negotiationPower(state2);
  const demand = negotiationDemand(terms, state2);
  const dayLocked = state2.day < MIN_SUCCESS_DAY;
  const success = !dayLocked && state2.iran.stance !== "DESPERATE" && power >= demand;
  return {
    success,
    power,
    demand,
    dayLocked,
    near: !dayLocked && !success && state2.iran.stance !== "DESPERATE" && demand - power <= 15
  };
}
function negotiatedEndingId(state2, terms) {
  const hard = terms.filter((value) => value === 2).length;
  const soft = terms.filter((value) => value === 0).length;
  if (state2.day < MIN_SUCCESS_DAY) return null;
  if (state2.flags.ceasefire && state2.dials.transit >= 75 && state2.maxEsc <= 3) return "calm_hold";
  if (state2.day <= 18 && state2.dials.transit >= 85 && state2.maxEsc <= 3) return "short_war";
  if (state2.dials.intl >= 70 && hard >= 1 && soft <= 2) return "hormuz_accord";
  return "uneasy_truce";
}
function finalizeEnding(state2, endingId, endings2) {
  const ending = endings2.find((item) => item.id === endingId) || endings2.find((item) => item.id === "endless_war");
  const score = computeScore({
    endDay: Math.max(1, state2.day),
    endingId: ending.id,
    endingGrade: ending.grade,
    oil: state2.dials.oil,
    approval: state2.dials.approval,
    intl: state2.dials.intl,
    transit: state2.dials.transit,
    maxEsc: state2.maxEsc
  });
  state2.phase = "ENDING";
  state2.ended = {
    endingId: ending.id,
    name: ending.name,
    tagline: ending.tagline,
    grade: ending.grade,
    endDay: Math.max(1, state2.day),
    score: score.total,
    parts: score.parts,
    seed: state2.seed
  };
  return state2.ended;
}

// tools/simulate-runs.mjs
var readJson = async (name) => JSON.parse(await readFile(new URL(`../assets/data/${name}.json`, import.meta.url), "utf8"));
var [cards, events, endings] = await Promise.all([
  readJson("cards"),
  readJson("events"),
  readJson("endings")
]);
function play(seed) {
  const state2 = freshState(seed);
  const random = mulberry32(seed);
  state2.day = 1;
  state2.phase = "DAY_BRIEF";
  while (!state2.ended) {
    for (const track of DAILY_DECISION_TRACKS) {
      const options = curatePolicyTrack(state2, cards, random, track);
      const policy = options[Math.floor(random() * options.length)] || options[0];
      const factor = policy.cat === "MIL" ? 0.55 : policy.cat === "DIP" ? 0.45 : 0.5;
      applyDelta(state2, Object.fromEntries(
        Object.entries(policy.delta || {}).map(([key, value]) => [key, Number(value) * factor])
      ));
      if (policy.flag) state2.flags[policy.flag] = true;
      state2.flags.history.push(policy.id);
      if (policy.negotiation && state2.day >= MIN_SUCCESS_DAY && state2.negotiation.tries > 0) {
        state2.negotiation.open = true;
        state2.act = "EXIT";
        const terms = Array.from({ length: 4 }, () => random() < 0.66 ? 0 : 1);
        const result = resolveNegotiation(state2, terms);
        if (result.success) {
          const endingId = negotiatedEndingId(state2, terms);
          if (endingId) finalizeEnding(state2, endingId, endings);
          break;
        }
        state2.negotiation.tries--;
        applyDelta(state2, { esc: 1, intl: result.near ? 1 : -3 });
      }
    }
    if (state2.ended) break;
    const event = chooseIranEvent(state2, events, random);
    if (event.minigame) {
      applyDelta(state2, random() < 0.76 ? event.success : event.failure);
    } else if (event.urgent) {
      const choice = event.urgent.choices[Math.floor(random() * event.urgent.choices.length)];
      applyDelta(state2, choice.delta);
      if (choice.flag) state2.flags[choice.flag] = true;
    }
    state2.flags.history.push(event.id);
    resolveDay(state2);
    const terminal = checkTerminalEnding(state2);
    if (terminal) {
      finalizeEnding(state2, terminal, endings);
      break;
    }
    state2.day = Math.min(MAX_CAMPAIGN_DAY, state2.day + 1);
  }
  return state2.ended;
}
var runs = Array.from({ length: 100 }, (_, index) => play(1213157965 + index * 7919 >>> 0));
var endingsCount = {};
var gradesCount = {};
for (const result of runs) {
  endingsCount[result.endingId] = (endingsCount[result.endingId] || 0) + 1;
  gradesCount[result.grade] = (gradesCount[result.grade] || 0) + 1;
}
var scores = runs.map((result) => result.score);
var days = runs.map((result) => result.endDay);
var report = {
  runs: runs.length,
  endingDistribution: endingsCount,
  gradeDistribution: gradesCount,
  score: {
    min: Math.min(...scores),
    max: Math.max(...scores),
    average: Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length)
  },
  endDay: {
    min: Math.min(...days),
    max: Math.max(...days),
    average: Number((days.reduce((sum, value) => sum + value, 0) / days.length).toFixed(1))
  },
  invariants: {
    allEnded: runs.every(Boolean),
    scoreWithinCap: scores.every((score) => score >= 0 && score <= 3500),
    dayWithinRange: days.every((day) => day >= 1 && day <= MAX_CAMPAIGN_DAY),
    successfulEndingsRespectMinimumDay: runs.every(
      (result) => !["calm_hold", "short_war", "hormuz_accord", "uneasy_truce"].includes(result.endingId) || result.endDay >= MIN_SUCCESS_DAY
    )
  }
};
console.log(JSON.stringify(report, null, 2));
var outputDirectory = new URL("../output/validation/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });
await writeFile(new URL("simulation-100-runs.json", outputDirectory), `${JSON.stringify(report, null, 2)}
`, "utf8");
if (!Object.values(report.invariants).every(Boolean)) process.exitCode = 1;
