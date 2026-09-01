import {
  state, update, resetGame, hasSavedRun, getSavedRunSummary,
  restoreLocalProgress, saveCheckpoint, REPLAY_KEY
} from "./core/state.js";
import { applyDelta } from "./core/rules.js";
import { GameDirector } from "./core/director.js";
import { GameUI } from "./ui/game_ui.js";
import { HormuzWorld } from "./scene/world.js";
import { GoogleMapGameLayer } from "./scene/google_map_layer.js";
import {
  t, pick, getLang, setLang, initLang, loadDictionaries,
  applyStaticI18n, onLangChange
} from "./core/i18n.js";

const DATA_FILES = [
  "cards", "events", "endings", "timeline", "missions", "campaign",
  "president_statements", "geo_features", "coastline"
];
const DATA_VERSION = "37";
const INTRO_BATTLE_RESULT_KEY = "hormuzIntroBattleResultV1";
const RTS_RUNTIME_VERSION = "138";
const MAIN_RUNTIME_VERSION = "145";

async function fetchJson(name) {
  const response = await fetch(`assets/data/${name}.json?v=${DATA_VERSION}`);
  if (!response.ok) throw new Error(`${name}.json HTTP ${response.status}`);
  return response.json();
}

async function fetchData() {
  const records = await Promise.all(DATA_FILES.map(async (name) => [name, await fetchJson(name)]));
  return Object.fromEntries(records);
}

/**
 * 문구 사전은 시작 화면보다 먼저 필요하므로 나머지 데이터와 분리해 먼저 읽는다.
 * 두 파일 모두 작아 첫 화면 표시를 늦추지 않는다.
 */
async function fetchDictionaries() {
  const [ko, en] = await Promise.all([fetchJson("strings.ko"), fetchJson("strings.en")]);
  return { ko, en };
}

/**
 * 결정 패널·모달·리플레이가 열려 있는 동안 우하단 개발자 버튼을 숨긴다.
 * 버튼이 조작 UI 를 가리지 않게 하기 위해서다. CSS :has(:empty) 무효화가
 * 브라우저마다 불안정해 감시자가 버튼에 직접 클래스를 토글한다.
 */
function watchGameOverlays() {
  const link = document.querySelector(".developer-fixed-link");
  const decisions = document.querySelector("#decision-panel");
  const modal = document.querySelector("#modal-layer");
  const replay = document.querySelector("#replay-screen");
  if (!link || !decisions || !modal || !replay) return;
  const sync = () => {
    const busy = decisions.classList.contains("open")
      || modal.childElementCount > 0
      || replay.childElementCount > 0;
    link.classList.toggle("overlay-hidden", busy);
  };
  const observer = new MutationObserver(sync);
  observer.observe(decisions, { attributes: true, attributeFilter: ["class"] });
  observer.observe(modal, { childList: true });
  observer.observe(replay, { childList: true });
  sync();
}

/**
 * 좌상단 HORMUZ 를 누르면 시작 화면으로 돌아간다.
 *
 * 진행 중인 작전이 있으면 한 번 물어본다. 체크포인트가 남아 있어 잃는 것은
 * 없지만, 전장을 보다가 잘못 눌러 화면이 통째로 바뀌면 사고처럼 느껴진다.
 * 되돌아갈 때는 자동 시작 파라미터를 떼서 시작 화면이 그대로 뜨게 한다.
 */
function bindBrandHome() {
  const brand = document.querySelector("#brand-home");
  if (!brand) return;
  brand.addEventListener("click", () => {
    const running = state.day > 0 || state.replay.choices.length > 0;
    if (running && !window.confirm(t("hud.confirmLeaveRun"))) return;
    // 자동 시작 파라미터를 떼야 시작 화면이 뜬다. 언어는 유지한다.
    const target = new URL(location.pathname, location.href);
    target.searchParams.set("lang", getLang());
    location.href = target.href;
  });
}

/** 타이틀 화면의 한/영 토글. 여기서 고른 값만 저장한다. */
function bindLangSwitch(onChange) {
  const group = document.querySelector("#lang-switch");
  if (!group) return;
  const paint = () => {
    group.querySelectorAll("[data-lang]").forEach((button) => {
      const active = button.dataset.lang === getLang();
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  };
  group.querySelectorAll("[data-lang]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.lang === getLang()) return;
      setLang(button.dataset.lang, { persist: true });
    });
  });
  onLangChange(() => {
    paint();
    onChange();
  });
  paint();
}

function replayWasSeen() {
  try { return localStorage.getItem(REPLAY_KEY) === "1"; }
  catch { return false; }
}

function markReplaySeen() {
  try { localStorage.setItem(REPLAY_KEY, "1"); }
  catch { /* replay remains optional when storage is blocked */ }
}

const HISTORY_METRICS = {
  transit: { key: "dial.transit", suffix: "%", goodDirection: 1 },
  oil: { key: "dial.oil", prefix: "$", goodDirection: -1 },
  approval: { key: "dial.approval", suffix: "%", goodDirection: 1 },
  intl: { key: "dial.intl", suffix: "%", goodDirection: 1 },
  ammo: { key: "dial.ammo", suffix: "%", goodDirection: 1 },
  esc: { key: "dial.esc", suffixKey: "dial.escSuffix", goodDirection: -1 },
  budget: { key: "dial.budget", prefix: "$", suffix: "M", goodDirection: 1 },
  party: { key: "dial.party", suffix: "%", goodDirection: 1 },
  congress: { key: "dial.congress", suffix: "%", goodDirection: 1 }
};

function metricSuffix(meta) {
  return meta.suffixKey ? t(meta.suffixKey) : (meta.suffix || "");
}

function historyMissionById(missionData, id) {
  return missionData?.missions?.find((mission) => mission.id === id) || null;
}

function historyMetricValue(key, value) {
  const meta = HISTORY_METRICS[key];
  return `${meta.prefix || ""}${Math.round(value)}${metricSuffix(meta)}`;
}

function historyImpactMarkup(before, after) {
  const changes = Object.keys(HISTORY_METRICS)
    .map((key) => ({
      key,
      before: Number(before[key]) || 0,
      after: Number(after[key]) || 0
    }))
    .filter((change) => Math.abs(change.after - change.before) >= 0.5)
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));
  if (!changes.length) {
    return `<p class="history-no-change">${t("history.noChange")}</p>`;
  }
  return `<section class="history-impact-grid" aria-label="${t("history.impactAria")}">
    ${changes.map((change) => {
      const delta = Math.round(change.after - change.before);
      const meta = HISTORY_METRICS[change.key];
      const favorable = Math.sign(delta) === meta.goodDirection;
      return `<article class="${favorable ? "good" : "bad"}">
        <span>${t(meta.key)}</span>
        <strong>${delta > 0 ? "+" : ""}${delta}</strong>
        <small>${historyMetricValue(change.key, change.before)} → ${historyMetricValue(change.key, change.after)}</small>
      </article>`;
    }).join("")}
  </section>`;
}

function applyHistoryBattleResult(current, mission, result) {
  const political = result.politics || {};
  const supplemental = Math.max(0, Number(result.supplementalBudget) || 0);
  const budgetUsed = Math.max(0, Number(result.budgetUsed) || 0);
  current.politics.authorizedBudget += supplemental;
  current.politics.supplementalBudget += supplemental;
  current.politics.spentBudget += budgetUsed;
  if (Number.isFinite(Number(political.congressSupport))) {
    current.politics.congressSupport = Math.max(0, Math.min(100, Number(political.congressSupport)));
  }
  if (Number.isFinite(Number(political.partySupport))) {
    current.politics.partySupport = Math.max(0, Math.min(100, Number(political.partySupport)));
  }
  current.politics.appropriationsPassed += supplemental && !political.forcedAppropriation ? 1 : 0;
  current.politics.forcedAppropriations += political.forcedAppropriation ? 1 : 0;
  applyDelta(current, {
    ...(result.success ? mission.success : mission.failure),
    approval: (result.success ? mission.success?.approval || 0 : mission.failure?.approval || 0)
      + (Number(political.approvalDelta) || 0),
    intl: (result.success ? mission.success?.intl || 0 : mission.failure?.intl || 0)
      + (Number(political.intlDelta) || 0)
  });
  const operationId = `history_${mission.scenario || mission.id}`;
  const list = result.success
    ? current.campaign.completedOperations
    : current.campaign.failedOperations;
  if (!list.includes(operationId)) list.push(operationId);
  current.campaign.lastBattle = {
    id: operationId,
    success: Boolean(result.success),
    budgetUsed,
    destroyed: Number(result.destroyed) || 0,
    at: new Date().toISOString()
  };
  current.flags.history.push(`${operationId}_${result.success ? "success" : "failure"}`);
  current.log.push(t("mission.resultLine", {
    title: pick(mission, "title"),
    outcome: t(result.success ? "mission.objectiveMet" : "mission.objectiveMissed"),
    destroyed: Number(result.destroyed) || 0,
    target: mission.targetCount,
    budget: budgetUsed
  }));
}

async function runReplay(timeline, ui, missionData) {
  const screen = document.querySelector("#replay-screen");
  const startIndex = state.resume?.stage === "replay"
    ? Math.max(state.resume.replayIndex || 0, state.replay.choices.length)
    : 0;
  for (let index = Math.min(startIndex, timeline.length); index < timeline.length; index++) {
    const item = timeline[index];
    const before = ui.metricSnapshot(state);
    const choice = await new Promise((resolve) => {
      screen.innerHTML = `<article class="replay-card">
        <div class="replay-progress">${timeline.map((_, step) => `<i class="${step <= index ? "done" : ""}"></i>`).join("")}</div>
        <figure class="replay-visual"><img src="${item.image || "assets/images/briefings/us-national-security-council-v1.webp"}" alt="" decoding="async"></figure>
        <span class="replay-date">${item.date}</span>
        <h2>${pick(item, "title")}</h2>
        <p>${pick(item, "question")}</p>
        <div class="replay-options">${item.choices.map((option, optionIndex) =>
          `<button data-replay="${optionIndex}">
            <strong>${pick(option, "name")}</strong>
            <span>${pick(option, "desc")}</span>
            ${option.battle ? `<em class="history-battle-chip">${t("history.battleChip")}</em>` : ""}
            ${ui.deltaMarkup(option.mod)}
          </button>`
        ).join("")}</div>
      </article>`;
      screen.querySelectorAll("[data-replay]").forEach((button) => {
        button.addEventListener("click", () => resolve(item.choices[Number(button.dataset.replay)]));
      });
    });
    const baseDelta = { ...(choice.mod || {}) };
    if (choice.battle) {
      delete baseDelta.budget;
      delete baseDelta.ammo;
    }
    update((current) => {
      current.replay.choices.push(choice.id);
      if (choice.id === item.historical) current.replay.match++;
      applyDelta(current, baseDelta);
      current.flags.history.push(`history_choice_${choice.id}`);
      current.log.push(`${pick(item, "title")}: ${pick(choice, "name")}`);
    });
    let battleResult = null;
    let battleMission = null;
    if (choice.battle?.mission) {
      battleMission = historyMissionById(missionData, choice.battle.mission);
      if (battleMission) {
        const availableBudget = Math.max(
          0,
          state.politics.authorizedBudget - state.politics.spentBudget
        );
        const missionBudget = Math.min(battleMission.budgetCap || 480, availableBudget);
        screen.innerHTML = `<article class="replay-card history-battle-launch">
          <div class="replay-progress">${timeline.map((_, step) => `<i class="${step <= index ? "done" : ""}"></i>`).join("")}</div>
          <figure class="replay-visual"><img src="${choice.result?.image || item.image}" alt="" decoding="async"></figure>
          <span class="replay-date">${item.date} · ${t("history.dateSuffix")}</span>
          <h2>${pick(choice.result || {}, "title") || pick(choice, "name")}</h2>
          <p>${pick(choice.result || {}, "summary") || pick(choice, "desc")}</p>
          <div class="history-battle-loading">
            <strong>${pick(battleMission, "title")}</strong>
            <span>${t("history.budgetLine", { budget: missionBudget })}</span>
          </div>
        </article>`;
        if (ui.auto) {
          battleResult = {
            success: true,
            destroyed: battleMission.targetCount,
            budgetUsed: Math.min(battleMission.budgetRecommended || missionBudget, missionBudget),
            supplementalBudget: 0,
            alliesAlive: 5,
            civiliansAlive: 3,
            politics: {
              congressSupport: state.politics.congressSupport,
              partySupport: state.politics.partySupport,
              approvalDelta: 0,
              intlDelta: 0,
              forcedAppropriation: false
            }
          };
        } else {
          await ui.sleep(180);
          screen.classList.add("battle-active");
          try {
            battleResult = await ui.runRtsBattle(battleMission, {
              budget: missionBudget,
              congressSupport: state.politics.congressSupport,
              partySupport: state.politics.partySupport,
              approval: state.dials.approval
            });
          } finally {
            screen.classList.remove("battle-active");
          }
        }
        if (battleResult) {
          update((current) => applyHistoryBattleResult(current, battleMission, battleResult));
        }
      }
    }
    const historical = item.choices.find((option) => option.id === item.historical);
    ui.render(state);
    const after = ui.metricSnapshot(state);
    const resultMeta = choice.result || {};
    const battleSuccess = Boolean(battleResult?.success);
    const resultTitle = battleResult
      ? pick(resultMeta, battleSuccess ? "successTitle" : "failureTitle")
      : pick(resultMeta, "title");
    const resultSummary = battleResult
      ? pick(resultMeta, battleSuccess ? "successSummary" : "failureSummary")
      : pick(resultMeta, "summary");
    screen.innerHTML = `<article class="replay-card replay-result-card ${battleResult ? (battleSuccess ? "success" : "failure") : ""}">
      <div class="replay-progress">${timeline.map((_, step) => `<i class="${step <= index ? "done" : ""}"></i>`).join("")}</div>
      <figure class="replay-visual history-result-visual">
        <img src="${resultMeta.image || item.image}" alt="" decoding="async">
        <figcaption>${battleResult
          ? t(battleSuccess ? "history.battleSuccessCaption" : "history.battleFailureCaption")
          : t("history.policyCaption")}</figcaption>
      </figure>
      <span class="replay-date">${item.date} · ${pick(choice, "name")}</span>
      <h2>${resultTitle || t("history.resultTitleFallback", { name: pick(choice, "name") })}</h2>
      <p>${resultSummary || pick(choice, "desc")}</p>
      ${battleResult && battleMission ? `<section class="history-battle-report">
        <article><span>${t("history.battleResult")}</span><strong>${t(battleSuccess ? "common.success" : "common.failure")}</strong></article>
        <article><span>${t("history.targetsDown")}</span><strong>${Number(battleResult.destroyed) || 0}/${battleMission.targetCount}</strong></article>
        <article><span>${t("history.operationCost")}</span><strong>$${Number(battleResult.budgetUsed) || 0}M</strong></article>
        <article><span>${t("history.alliesAlive")}</span><strong>${Number(battleResult.alliesAlive) || 0}</strong></article>
      </section>` : ""}
      <span class="history-impact-title">${t("history.impactTitle")}</span>
      ${historyImpactMarkup(before, after)}
      <div class="history-result">
        <span>${t("history.savedToStart")}</span>
        <strong>${t("history.actualOutcome", { name: pick(historical, "name") })}</strong>
        <button class="primary-button" id="next-history" type="button">${index === timeline.length - 1 ? t("history.toPresent") : t("history.next")}</button>
      </div>
    </article>`;
    if (ui.auto) {
      await ui.sleep(120);
    } else {
      await new Promise((resolve) => {
        screen.querySelector("#next-history").addEventListener("click", resolve, { once: true });
      });
    }
    update((current) => {
      current.phase = "REPLAY";
      current.resume = {
        stage: "replay",
        day: 0,
        replayIndex: index + 1,
        policy: null,
        policyStep: 0,
        eventId: ""
      };
    });
    saveCheckpoint(t("history.checkpoint", {
      index: index + 1, total: timeline.length, title: pick(item, "title")
    }));
  }
  screen.innerHTML = "";
  markReplaySeen();
  update((current) => {
    current.phase = "NEWSREEL";
    current.resume = {
      stage: "intro",
      day: 0,
      replayIndex: timeline.length,
      policy: null,
      policyStep: 0,
      eventId: ""
    };
  });
  saveCheckpoint(t("history.checkpointConvoy"));
}

function titleChoice() {
  const title = document.querySelector("#title-screen");
  const start = document.querySelector("#start-game");
  const resume = document.querySelector("#continue-game");
  const history = document.querySelector("#history-game");
  const status = document.querySelector("#title-load-status");
  const summary = getSavedRunSummary();
  const saved = hasSavedRun() && summary;
  const summaryPanel = document.querySelector("#save-summary");
  const summaryTitle = document.querySelector("#save-summary-title");
  const summaryTime = document.querySelector("#save-summary-time");
  const summaryMetrics = document.querySelector("#save-summary-metrics");
  const summaryRecent = document.querySelector("#save-summary-recent");
  resume.hidden = !saved;
  summaryPanel.hidden = !saved;
  title.classList.toggle("has-save", Boolean(saved));
  if (saved) {
    summaryTitle.textContent = summary.label;
    const savedTime = Date.parse(summary.savedAt);
    summaryTime.textContent = Number.isFinite(savedTime)
      ? t("title.savedAt", {
          time: new Intl.DateTimeFormat(getLang() === "ko" ? "ko-KR" : "en-US", {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit"
          }).format(new Date(savedTime))
        })
      : t("title.legacySave");
    const metricOrder = ["transit", "oil", "approval", "intl", "ammo", "esc", "budget", "party"];
    summaryMetrics.replaceChildren(...metricOrder.map((key) => {
      const meta = HISTORY_METRICS[key];
      const item = document.createElement("span");
      const label = document.createElement("small");
      const value = document.createElement("strong");
      label.textContent = t(meta.key);
      value.textContent = historyMetricValue(key, summary.metrics[key]);
      item.append(label, value);
      return item;
    }));
    summaryRecent.textContent = summary.recent;
    resume.querySelector("span").textContent = summary.day > 0
      ? t("title.continueFromDay", { day: summary.day })
      : t("title.continueFromLast");
    resume.querySelector("small").textContent = summary.label;
    start.querySelector("span").textContent = t("title.startOver");
    start.querySelector("small").textContent = t("title.startOverSub");
  }
  [start, resume, history].forEach((button) => {
    button.disabled = false;
  });
  title.classList.add("ready");
  if (status) status.textContent = t("title.loadReady");
  return new Promise((resolve) => {
    const choose = (operation) => {
      [start, resume, history].forEach((button) => {
        button.disabled = true;
      });
      if (status) status.textContent = t("title.loadChosen");
      resolve(operation);
    };
    start.addEventListener("click", () => {
      if (saved && !window.confirm(t("title.confirmRestart"))) return;
      choose("new");
    });
    resume.addEventListener("click", () => choose("continue"), { once: true });
    history.addEventListener("click", () => choose("history"), { once: true });
    title.classList.remove("hidden");
  });
}

function consumeIntroBattleResult() {
  try {
    const result = JSON.parse(localStorage.getItem(INTRO_BATTLE_RESULT_KEY) || "null");
    localStorage.removeItem(INTRO_BATTLE_RESULT_KEY);
    if (!result?.success || result.missionId !== "convoy_shield") return null;
    const age = Date.now() - Number(result.completedAt || 0);
    return age >= 0 && age <= 6 * 60 * 60 * 1000 ? result : null;
  } catch {
    return null;
  }
}

function launchIntroBattle(startMode = "new", timelineComplete = false) {
  const battleUrl = new URL("rts-combat.html", location.href);
  battleUrl.searchParams.set("v", RTS_RUNTIME_VERSION);
  // 인트로 전투도 본편과 같은 언어로 열어야 한다. 빠뜨리면 영어 사용자에게
  // 첫 전투가 한국어로 나온다.
  battleUrl.searchParams.set("lang", getLang());
  battleUrl.searchParams.set("campaign", "intro");
  battleUrl.searchParams.set("scenario", "convoy_shield");
  battleUrl.searchParams.set("day", "1");
  battleUrl.searchParams.set("difficulty", "1");
  battleUrl.searchParams.set("variant", "0");
  battleUrl.searchParams.set("repeat", "0");
  battleUrl.searchParams.set("esc", "3");
  battleUrl.searchParams.set("stance", "HARDLINE");
  battleUrl.searchParams.set("seed", String(Number(state.seed) || 0));
  battleUrl.searchParams.set("budget", "480");
  battleUrl.searchParams.set("congress", "39");
  battleUrl.searchParams.set("party", "58");
  battleUrl.searchParams.set(
    "return",
    `index.html?autostart=1&prologue=complete&startMode=${startMode}${timelineComplete ? "&timeline=complete" : ""}`
  );
  location.href = battleUrl.href;
}

function applyIntroBattleResult(result) {
  update((current) => {
    const politics = result.politics || {};
    current.flags.introMissionDone = true;
    current.flags.history.push("mission_convoy_shield");
    current.campaign.prologuePassed = true;
    current.campaign.completedOperations = [
      ...new Set([...current.campaign.completedOperations, "convoy_shield"])
    ];
    current.campaign.lastBattle = {
      id: "convoy_shield",
      success: true,
      budgetUsed: Number(result.budgetUsed) || 0,
      destroyed: Number(result.destroyed) || 0,
      day: 1,
      difficulty: Number(result.difficulty) || 1,
      variant: Number(result.variant) || 0,
      at: new Date().toISOString()
    };
    if (!Array.isArray(current.campaign.battleHistory)) current.campaign.battleHistory = [];
    current.campaign.battleHistory.push({
      id: "convoy_shield",
      success: true,
      day: 1,
      difficulty: Number(result.difficulty) || 1,
      variant: Number(result.variant) || 0,
      forces: result.forces && typeof result.forces === "object" ? { ...result.forces } : {},
      at: new Date().toISOString()
    });
    current.campaign.battleHistory = current.campaign.battleHistory.slice(-60);
    current.politics.authorizedBudget += Math.max(0, Number(result.supplementalBudget) || 0);
    current.politics.supplementalBudget += Math.max(0, Number(result.supplementalBudget) || 0);
    current.politics.spentBudget += Math.max(0, Number(result.budgetUsed) || 0);
    if (Number.isFinite(Number(politics.congressSupport))) {
      current.politics.congressSupport = Math.max(
        0,
        Math.min(100, Number(politics.congressSupport))
      );
    }
    if (Number.isFinite(Number(politics.partySupport))) {
      current.politics.partySupport = Math.max(
        0,
        Math.min(100, Number(politics.partySupport))
      );
    }
    current.politics.forcedAppropriations += politics.forcedAppropriation ? 1 : 0;
    current.politics.appropriationsPassed += (
      result.supplementalBudget && !politics.forcedAppropriation ? 1 : 0
    );
    applyDelta(current, {
      transit: 8,
      approval: 5 + (Number(politics.approvalDelta) || 0),
      ammo: -5,
      intl: -3 + (Number(politics.intlDelta) || 0),
      stability: -4
    });
    current.log.push(t("history.introVictory", {
      budget: Number(result.budgetUsed) || 0
    }));
  });
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const fast = params.get("debug") === "fast";
  const auto = params.get("auto") === "1" || fast;
  const debugMission = params.get("mission")?.trim() || null;
  const root = document.querySelector("#game");
  const title = document.querySelector("#title-screen");
  const loading = document.querySelector("#loading-screen");
  const autostart = params.get("autostart") === "1";
  const requestedMode = params.get("startMode");

  // 문구 사전과 언어 판별을 가장 먼저 끝낸다. 시작 화면부터 올바른 언어로 그린다.
  loadDictionaries(await fetchDictionaries());
  initLang();
  applyStaticI18n();
  // 토글은 시작 화면에 있으므로 게임 데이터가 오기 전에 미리 붙인다.
  bindLangSwitch(() => applyStaticI18n());
  watchGameOverlays();
  bindBrandHome();
  let operation = autostart && ["history", "continue"].includes(requestedMode)
    ? requestedMode
    : (autostart ? "new" : null);
  const titleOperation = autostart ? null : titleChoice();

  if (autostart) {
    root.classList.remove("title-booting");
    root.classList.add("boot-loading");
    title.classList.add("hidden");
    loading.classList.remove("hidden");
  } else {
    root.classList.remove("boot-loading");
    loading.classList.add("hidden");
    title.classList.remove("hidden");
  }
  if (params.get("mapcheck") === "1") document.documentElement.classList.add("map-check");
  const data = await fetchData();
  const googleMapDefault = params.get("google") !== "0";
  if (googleMapDefault) root.classList.add("google-map-pending");
  root.dataset.runtimeVersion = MAIN_RUNTIME_VERSION;
  const ui = new GameUI({ root, auto });
  /* 화면 검증용 손잡이.
   *
   * 대통령 발언처럼 게임을 며칠 진행해야 나오는 화면은 자동으로 몰아가기가
   * 어렵다(선택 카드에 클래스가 없어 잡기도 힘들다). 주소에 ?uiprobe=1 을
   * 붙였을 때만 열어, 그 화면 하나만 직접 띄워 확인할 수 있게 한다. */
  if (params.get("uiprobe") === "1") window.__HORMUZ_UI__ = ui;
  const world = new HormuzWorld({
    canvas: document.querySelector("#world-canvas"),
    labels: document.querySelector("#map-labels"),
    coastline: data.coastline,
    geo: data.geo_features
  });
  // 결정 패널이 열릴 때 지도가 위로 올라오려면 UI 가 장면을 알아야 한다.
  ui.scene = world;
  const updateGame = (mutator) => {
    const current = update(mutator);
    world.setDay(current);
    return current;
  };
  const googleTerrain = new GoogleMapGameLayer({
    root,
    host: document.querySelector("#google-game-map-host"),
    loading: document.querySelector("#google-game-map-loading"),
    toggle: document.querySelector("#google-map-mode"),
    labels: document.querySelector("#map-labels"),
    legend: document.querySelector(".map-legend"),
    world,
    defaultActive: googleMapDefault
  });
  const googleTerrainReady = googleMapDefault
    ? googleTerrain.init().catch((error) => {
      googleTerrain.fail(error);
      return false;
    })
    : Promise.resolve(false);
  googleTerrainReady.then(() => {
    const status = document.querySelector("#title-load-status");
    const start = document.querySelector("#start-game");
    if (!autostart && status && start && !start.disabled && !title.classList.contains("hidden")) {
      status.textContent = t("title.loadOperationReady");
    }
  });
  if (params.get("mapcheck") === "1") world.setMapMode(true);
  ui.render(state);
  world.setDay(state);

  // 언어를 바꾸면 계기판과 진행 중인 화면도 즉시 다시 그린다. 페이지는 새로 열지 않는다.
  onLangChange(() => ui.render(state));

  let cameraAuto = true;
  const autoCamera = document.querySelector("#auto-camera");
  autoCamera.addEventListener("click", () => {
    cameraAuto = !cameraAuto;
    world.setAutoCamera(cameraAuto);
    autoCamera.classList.toggle("active", cameraAuto);
  });
  document.querySelector("#campaign-office").addEventListener("click", () => {
    ui.showCampaignOffice(state, data.campaign, { update: updateGame });
  });

  // Google 3D terrain continues loading behind the title/replay screen. It must
  // never block the first menu or the user's first choice.
  void googleTerrainReady;
  root.classList.remove("boot-loading", "title-booting");
  loading.classList.add("hidden");
  if (!autostart) operation = await titleOperation;
  title.classList.add("hidden");
  let introResult = null;
  const timelineComplete = params.get("timeline") === "complete";
  let restored = false;
  if (operation === "continue" || (timelineComplete && !fast && !debugMission)) {
    restored = restoreLocalProgress();
  }
  if (operation === "continue" && !restored) operation = "new";

  // A direct mission URL is an explicit test/launch request. Do not put the
  // historical replay or the mandatory intro battle in front of that mission.
  if (!fast && !debugMission) {
    if (operation !== "continue" && !timelineComplete) {
      resetGame();
      update((current) => {
        current.phase = "REPLAY";
        current.resume = {
          stage: "replay",
          day: 0,
          replayIndex: 0,
          policy: null,
          policyStep: 0,
          eventId: ""
        };
      });
      saveCheckpoint(t("history.checkpointFirst"));
      await runReplay(data.timeline, ui, data.missions);
      launchIntroBattle(operation, true);
      return;
    }

    if (operation === "continue" && state.resume?.stage === "replay") {
      await runReplay(data.timeline, ui, data.missions);
      launchIntroBattle("continue", true);
      return;
    }

    introResult = params.get("prologue") === "complete" ? consumeIntroBattleResult() : null;
    if (introResult) {
      applyIntroBattleResult(introResult);
      update((current) => {
        current.day = Math.max(1, current.day);
        current.phase = "DAY_BRIEF";
        current.resume = {
          stage: "brief",
          day: current.day,
          replayIndex: current.replay.choices.length,
          policy: null,
          policyStep: 0,
          eventId: ""
        };
      });
      saveCheckpoint(t("history.checkpointDayOne"));
      restored = true;
    } else if (
      state.day === 0
      && !state.campaign.prologuePassed
      && (timelineComplete || state.resume?.stage === "intro" || operation === "continue")
    ) {
      update((current) => {
        current.phase = "NEWSREEL";
        current.resume = {
          stage: "intro",
          day: 0,
          replayIndex: current.replay.choices.length,
          policy: null,
          policyStep: 0,
          eventId: ""
        };
      });
      saveCheckpoint(t("history.checkpointConvoy"));
      launchIntroBattle(operation, true);
      return;
    }
  }

  if (!restored && (fast || debugMission || operation !== "continue")) {
    resetGame();
  }

  world.setDay(state);
  const director = new GameDirector({
    state,
    update: updateGame,
    cards: data.cards,
    events: data.events,
    endings: data.endings,
    missions: data.missions,
    campaign: data.campaign,
    presidentStatements: data.president_statements,
    ui,
    scene: world,
    fast,
    debugMission
  });
  window.__HORMUZ__ = { state, director, world, googleTerrain, data };
  if (params.get("mapcheck") === "1" || params.get("scenecheck") === "1") return;
  await director.start();
  if (director.endAction === "restart") {
    location.href = `${location.pathname}?${fast ? "debug=fast&autostart=1" : ""}`;
  }
}

boot().catch((error) => {
  console.error(error);
  document.querySelector("#game")?.classList.remove("boot-loading");
  const fatal = document.querySelector("#fatal-error");
  fatal.hidden = false;
  fatal.textContent = t("loading.fatal", { message: error.message });
  document.querySelector("#loading-screen")?.classList.add("hidden");
});
