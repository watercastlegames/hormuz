import { t } from "./i18n.js";

// 저장 데이터에 남는 기본 표시 이름. 언어를 바꿔도 기존 저장을 깨지 않도록
// 값 자체는 고정하고, 화면 표시는 t()로 바꾼다.
const ANONYMOUS_COMMANDER = "anonymous_commander";

export const STORAGE_KEY = "hormuzProgressV1";
export const CHECKPOINT_KEY = "hormuzCheckpointV2";
export const BEST_KEY = "hormuzLocalBestV1";
export const REPLAY_KEY = "hormuzReplaySeenV1";
export const VALID_PHASES = new Set([
  "TITLE", "NEWSREEL", "REPLAY", "DAY_BRIEF", "DAY_POLICY", "DAY_EXEC",
  "DAY_IRAN", "DAY_RESOLVE", "NEGOTIATION", "MISSION", "ENDING"
]);
const VALID_RESUME_STAGES = new Set([
  "title", "replay", "intro", "brief", "policy", "policy_execute",
  "iran", "iran_response", "president", "resolve", "report"
]);
const DELTA_KEYS = new Set([
  "transit", "oil", "approval", "intl", "ammo", "esc", "stability",
  "missiles", "budget", "party", "congress"
]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const cleanText = (value, max = 80) => String(value ?? "").slice(0, max);

export function freshState(seed = ((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0)) {
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
      authorizedBudget: 6000,
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
    user: { displayName: ANONYMOUS_COMMANDER, demo: true },
    ended: null
  };
}

export const state = freshState();
const listeners = new Set();

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  saveLocalProgress();
  listeners.forEach((listener) => listener(state));
}

export function update(mutator) {
  if (typeof mutator === "function") mutator(state);
  else Object.assign(state, mutator);
  notify();
  return state;
}

export function resetGame({ keepUser = true } = {}) {
  const user = keepUser ? { ...state.user } : null;
  const lang = state.lang;
  Object.assign(state, freshState());
  state.lang = lang;
  if (user) state.user = user;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(CHECKPOINT_KEY);
  notify();
  return state;
}

export function saveLocalProgress() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable in privacy mode; the run remains playable.
  }
}

function readJsonStorage(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function savedCandidate() {
  const checkpoint = readJsonStorage(CHECKPOINT_KEY);
  if (
    checkpoint?.version === 2
    && checkpoint?.state?.gameId === "hormuz-v1"
    && checkpoint?.state?.phase !== "TITLE"
    && !checkpoint?.state?.ended
  ) {
    return {
      data: checkpoint.state,
      savedAt: cleanText(checkpoint.savedAt, 40),
      label: cleanText(checkpoint.label, 100),
      safe: true
    };
  }

  const legacy = readJsonStorage(STORAGE_KEY);
  if (legacy?.gameId === "hormuz-v1" && legacy?.phase !== "TITLE" && !legacy?.ended) {
    return {
      data: legacy,
      savedAt: cleanText(legacy.savedAt, 40),
      label: "",
      safe: false
    };
  }
  return null;
}

function cleanDelta(delta) {
  if (!delta || typeof delta !== "object") return {};
  return Object.fromEntries(
    Object.entries(delta)
      .filter(([key, value]) => DELTA_KEYS.has(key) && Number.isFinite(Number(value)))
      .map(([key, value]) => [key, clamp(value, -10000, 10000)])
  );
}

function cleanPolicy(policy) {
  if (!policy || typeof policy !== "object") return null;
  return {
    id: cleanText(policy.id, 50),
    cat: cleanText(policy.cat, 20),
    name: cleanText(policy.name, 100),
    desc: cleanText(policy.desc, 240),
    delta: cleanDelta(policy.delta),
    flag: cleanText(policy.flag, 50),
    mission: cleanText(policy.mission, 50),
    negotiation: Boolean(policy.negotiation),
    fx: cleanText(policy.fx, 50)
  };
}

function cleanResume(resume, day) {
  const stage = VALID_RESUME_STAGES.has(resume?.stage) ? resume.stage : (day > 0 ? "brief" : "intro");
  const resumeDay = clamp(resume?.day ?? day, 0, 54);
  return {
    stage: resumeDay === day || ["replay", "intro", "title"].includes(stage)
      ? stage
      : (day > 0 ? "brief" : "intro"),
    day: resumeDay === day ? resumeDay : day,
    replayIndex: clamp(resume?.replayIndex, 0, 8),
    policy: cleanPolicy(resume?.policy),
    policyStep: clamp(resume?.policyStep, 0, 3),
    eventId: cleanText(resume?.eventId, 50)
  };
}

function restoreData(data, { safe = false } = {}) {
  const restored = freshState(clamp(data.seed, 0, 0xffffffff));
  restored.phase = VALID_PHASES.has(data.phase) ? data.phase : "TITLE";
  if (!safe && ["DAY_EXEC", "DAY_IRAN", "DAY_RESOLVE", "MISSION", "NEGOTIATION"].includes(restored.phase)) {
    restored.phase = "DAY_BRIEF";
  }
  restored.lang = data.lang === "en" ? "en" : "ko";
  restored.day = clamp(data.day, 0, 54);
  restored.act = ["LULL", "REIGNITE", "ATTRITION", "EXIT"].includes(data.act) ? data.act : "LULL";
  restored.dials = {
    transit: clamp(data.dials?.transit, 0, 100),
    oil: clamp(data.dials?.oil, 40, 300),
    approval: clamp(data.dials?.approval, 0, 100),
    intl: clamp(data.dials?.intl, 0, 100),
    ammo: clamp(data.dials?.ammo, 0, 100),
    esc: clamp(data.dials?.esc, 1, 5)
  };
  restored.iran = {
    stance: ["PRAGMATIC", "HARDLINE", "DESPERATE"].includes(data.iran?.stance)
      ? data.iran.stance : "HARDLINE",
    stability: clamp(data.iran?.stability, 0, 100),
    revealed: Boolean(data.iran?.revealed),
    missiles: clamp(data.iran?.missiles, 0, 100)
  };
  restored.stocks = {
    tomahawk: clamp(data.stocks?.tomahawk ?? 14, 0, 100),
    thaad: clamp(data.stocks?.thaad ?? 8, 0, 100),
    spr: clamp(data.stocks?.spr ?? 1, 0, 20)
  };
  restored.maxEsc = clamp(data.maxEsc, 1, 5);
  restored.politics = {
    authorizedBudget: clamp(data.politics?.authorizedBudget ?? 6000, 0, 10000),
    supplementalBudget: clamp(data.politics?.supplementalBudget, 0, 10000),
    spentBudget: clamp(data.politics?.spentBudget, 0, 10000),
    congressSupport: clamp(data.politics?.congressSupport ?? 39, 0, 100),
    partySupport: clamp(data.politics?.partySupport ?? 58, 0, 100),
    appropriationsPassed: clamp(data.politics?.appropriationsPassed, 0, 20),
    forcedAppropriations: clamp(data.politics?.forcedAppropriations, 0, 20)
  };
  restored.campaign = {
    prologuePassed: Boolean(data.campaign?.prologuePassed),
    completedOperations: Array.isArray(data.campaign?.completedOperations)
      ? data.campaign.completedOperations.slice(0, 30).map((item) => cleanText(item, 40))
      : [],
    failedOperations: Array.isArray(data.campaign?.failedOperations)
      ? data.campaign.failedOperations.slice(0, 30).map((item) => cleanText(item, 40))
      : [],
    lastBattle: data.campaign?.lastBattle && typeof data.campaign.lastBattle === "object"
      ? {
          id: cleanText(data.campaign.lastBattle.id, 40),
          success: Boolean(data.campaign.lastBattle.success),
          budgetUsed: clamp(data.campaign.lastBattle.budgetUsed, 0, 10000),
          destroyed: clamp(data.campaign.lastBattle.destroyed, 0, 100),
          day: clamp(data.campaign.lastBattle.day, 0, 54),
          difficulty: clamp(data.campaign.lastBattle.difficulty || 1, 1, 5),
          variant: clamp(data.campaign.lastBattle.variant, 0, 2),
          at: cleanText(data.campaign.lastBattle.at, 40)
        }
      : null,
    battleHistory: Array.isArray(data.campaign?.battleHistory)
      ? data.campaign.battleHistory.slice(-60).map((entry) => ({
          id: cleanText(entry?.id, 40),
          success: Boolean(entry?.success),
          day: clamp(entry?.day, 0, 54),
          difficulty: clamp(entry?.difficulty || 1, 1, 5),
          variant: clamp(entry?.variant, 0, 2),
          forces: Object.fromEntries(
            Object.entries(entry?.forces && typeof entry.forces === "object" ? entry.forces : {})
              .filter(([key]) => [
                "destroyer", "fighter", "helicopter", "carrier", "usv", "bomber", "marine"
              ].includes(key))
              .map(([key, value]) => [key, clamp(value, 0, 12)])
          ),
          at: cleanText(entry?.at, 40)
        })).filter((entry) => entry.id)
      : []
  };
  restored.replay = {
    choices: Array.isArray(data.replay?.choices) ? data.replay.choices.slice(0, 8).map((item) => cleanText(item, 30)) : [],
    match: clamp(data.replay?.match, 0, 8)
  };
  restored.negotiation = {
    open: Boolean(data.negotiation?.open),
    tries: clamp(data.negotiation?.tries ?? 3, 0, 3),
    terms: Array.isArray(data.negotiation?.terms)
      ? data.negotiation.terms.slice(0, 4).map((value) => clamp(value, 0, 2))
      : [1, 1, 1, 1]
  };
  restored.flags = {
    lowApprovalDays: clamp(data.flags?.lowApprovalDays, 0, 54),
    desperateDays: clamp(data.flags?.desperateDays, 0, 54),
    history: Array.isArray(data.flags?.history) ? data.flags.history.slice(-160).map((item) => cleanText(item, 40)) : [],
    guarantee: Boolean(data.flags?.guarantee),
    reconstruction: Boolean(data.flags?.reconstruction),
    ceasefire: Boolean(data.flags?.ceasefire),
    revealed: Boolean(data.flags?.revealed),
    introMissionDone: Boolean(data.flags?.introMissionDone)
  };
  restored.log = Array.isArray(data.log) ? data.log.slice(-120).map((item) => cleanText(item, 180)) : [];
  restored.resume = safe
    ? cleanResume(data.resume, restored.day)
    : {
        stage: restored.phase === "REPLAY" ? "replay" : (restored.day > 0 ? "brief" : "intro"),
        day: restored.day,
        replayIndex: restored.replay.choices.length,
        policy: null,
        policyStep: 0,
        eventId: ""
      };
  restored.user = {
    displayName: cleanText(data.user?.displayName || ANONYMOUS_COMMANDER, 30),
    demo: true
  };
  restored.ended = null;
  return restored;
}

export function saveCheckpoint(label = "", resume = null) {
  if (resume && typeof resume === "object") {
    state.resume = cleanResume({ ...state.resume, ...resume }, state.day);
  }
  const payload = {
    version: 2,
    savedAt: new Date().toISOString(),
    label: cleanText(label, 100),
    state
  };
  try {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(payload));
    saveLocalProgress();
    return true;
  } catch {
    return false;
  }
}

export function hasSavedRun() {
  return Boolean(savedCandidate());
}

export function getSavedRunSummary() {
  const candidate = savedCandidate();
  if (!candidate) return null;
  const restored = restoreData(candidate.data, { safe: candidate.safe });
  const availableBudget = Math.max(
    0,
    restored.politics.authorizedBudget - restored.politics.spentBudget
  );
  return {
    day: restored.day,
    act: restored.act,
    phase: restored.phase,
    stage: restored.resume.stage,
    replayIndex: restored.resume.replayIndex,
    label: candidate.label || (restored.day > 0
      ? t("state.dayBriefLabel", { day: restored.day })
      : t("state.pastEventsLabel")),
    savedAt: candidate.savedAt,
    metrics: {
      transit: restored.dials.transit,
      oil: restored.dials.oil,
      approval: restored.dials.approval,
      intl: restored.dials.intl,
      ammo: restored.dials.ammo,
      esc: restored.dials.esc,
      budget: availableBudget,
      party: restored.politics.partySupport
    },
    recent: restored.log.slice(-1)[0] || t("state.resumeHint")
  };
}

export function restoreLocalProgress() {
  const candidate = savedCandidate();
  if (!candidate) return false;
  const restored = restoreData(candidate.data, { safe: candidate.safe });
  Object.assign(state, restored);
  notify();
  return true;
}

export function saveBest(record) {
  try {
    const previous = JSON.parse(localStorage.getItem(BEST_KEY) || "null");
    if (!previous || record.score > previous.score) {
      localStorage.setItem(BEST_KEY, JSON.stringify(record));
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function getBest() {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY) || "null");
  } catch {
    return null;
  }
}
