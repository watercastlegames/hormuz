import { negotiationDemand, negotiationPower } from "../core/rules.js";
import { saveBest } from "../core/state.js";
import { t, pick, getLang } from "../core/i18n.js";

const RTS_RUNTIME_VERSION = "138";

const DIALS = [
  ["transit", "dialShort.transit", "%"],
  ["oil", "dialShort.oil", "$"],
  ["approval", "dialShort.approval", ""],
  ["intl", "dialShort.intl", ""],
  ["ammo", "dialShort.ammo", ""],
  ["esc", "dialShort.esc", ""],
  ["budget", "dialShort.budget", "$M"],
  ["party", "dialShort.party", "%"]
];

const METRIC_META = {
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

/* 발언 화면에 쓰는 화자별 그림. 모두 뒷모습이고 얼굴이 보이지 않는다.
   실존 인물의 초상이 아니라 그 자리를 상징하는 익명의 뒷모습이다. */
const SPEAKER_IMAGES = {
  us: "assets/images/title/hormuz-main-title-cinematic-president-rear-v6.webp",
  israel: "assets/images/politics/israel-command-rear.webp",
  iran: "assets/images/politics/irgc-command-rear.webp",
  pakistan: "assets/images/politics/pakistan-mediation-rear.webp",
  qatar: "assets/images/politics/qatar-mediation-rear.webp",
  oman: "assets/images/politics/oman-mediation-rear.webp"
};

const CATEGORY_KEYS = {
  MIL: "cat.MIL", DIP: "cat.DIP", ECO: "cat.ECO", INFO: "cat.INFO", ASSET: "cat.ASSET"
};

/* 결정 카드 분류 배지에 붙일 그림.
 * 프로젝트매니저 '이미지 자료 자동 수집' war 테마에서 가져왔다.
 * 분류가 글자뿐이라 훑어볼 때 눈에 안 들어왔다. */
const CATEGORY_ICONS = {
  MIL: "cat-mil", DIP: "cat-dip", ECO: "cat-eco", INFO: "cat-info",
  ASSET: "cat-asset", ROE: "cat-roe", POLICY: "cat-policy"
};

function uiIconMarkup(name, className = "ui-icon") {
  if (!name) return "";
  return `<img class="${className}" src="assets/images/ui/war-icons/${name}.webp"`
    + ` alt="" loading="lazy" decoding="async">`;
}

function categoryIconMarkup(code) {
  return uiIconMarkup(CATEGORY_ICONS[code], "category-icon");
}

export class GameUI {
  constructor({ root, auto = false }) {
    this.root = root;
    this.auto = auto;
    this.pending = null;
    this.ticker = [];
    this.previousMetrics = null;
    this.changeTimer = 0;
    this.bindStatic();
  }

  bindStatic() {
    this.brief = this.root.querySelector("#brief-text");
    this.tickerText = this.root.querySelector("#ticker-text");
    this.decisions = this.root.querySelector("#decision-panel");
    this.modal = this.root.querySelector("#modal-layer");
    this.report = this.root.querySelector("#report-layer");
    this.hud = this.root.querySelector("#dial-grid");
    this.dayLabel = this.root.querySelector("#day-label");
    this.actLabel = this.root.querySelector("#act-label");
    this.progress = this.root.querySelector("#day-progress");
    this.changeFeedback = document.createElement("section");
    this.changeFeedback.className = "change-feedback";
    this.changeFeedback.setAttribute("aria-live", "polite");
    this.changeFeedback.hidden = true;
    this.root.append(this.changeFeedback);
    const ticker = this.root.querySelector(".ticker");
    ticker?.addEventListener("click", () => this.showNewsArchive());
    ticker?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.showNewsArchive();
    });
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  cancelPending() {
    if (this.pending?.resolve) this.pending.resolve(this.pending.fallback || null);
    this.pending = null;
    this.decisions.classList.remove("open");
    this.scene?.setViewLift?.(false);
    this.modal.replaceChildren();
  }

  render(state) {
    const metrics = this.metricSnapshot(state);
    const changes = this.previousMetrics
      ? Object.keys(metrics)
          .map((key) => ({ key, before: this.previousMetrics[key], after: metrics[key] }))
          .filter((item) => Math.abs(item.after - item.before) >= 0.5)
      : [];
    this.dayLabel.textContent = `DAY ${Math.max(1, state.day)} · ${this.dateText(state.day)}`;
    this.actLabel.textContent = t(`act.${state.act}`);
    this.progress.style.width = `${Math.max(2, state.day / 54 * 100)}%`;
    this.hud.innerHTML = DIALS.map(([key, nameKey, symbol]) => {
      const name = t(nameKey);
      const value = key === "budget"
        ? Math.max(0, state.politics.authorizedBudget - state.politics.spentBudget)
        : key === "party"
          ? state.politics.partySupport
          : state.dials[key];
      const tone = key === "oil" || key === "esc"
        ? (value > (key === "oil" ? 140 : 3) ? "danger" : "")
        : key === "budget"
          ? (value < 180 ? "danger" : value > 700 ? "good" : "")
          : (value < 35 ? "danger" : value > 70 ? "good" : "");
      const displayValue = key === "budget"
        ? `$${Math.round(value)}M`
        : symbol === "$"
          ? `$${Math.round(value)}`
          : `${Math.round(value)}${symbol === "%" ? "%" : ""}`;
      const change = changes.find((item) => item.key === key);
      return `<div class="dial ${tone}">
        <span class="dial-name">${name}</span>
        <span class="dial-icon icon-${key}" aria-hidden="true"></span>
        <strong>${displayValue}</strong>
        ${change ? this.compactTrendMarkup(change) : ""}
      </div>`;
    }).join("");
    if (changes.length) this.showChangeFeedback(changes);
    this.previousMetrics = metrics;
  }

  metricSnapshot(state) {
    return {
      transit: Number(state.dials.transit) || 0,
      oil: Number(state.dials.oil) || 0,
      approval: Number(state.dials.approval) || 0,
      intl: Number(state.dials.intl) || 0,
      ammo: Number(state.dials.ammo) || 0,
      esc: Number(state.dials.esc) || 0,
      budget: Math.max(
        0,
        (Number(state.politics?.authorizedBudget) || 0)
          - (Number(state.politics?.spentBudget) || 0)
      ),
      party: Number(state.politics?.partySupport) || 0,
      congress: Number(state.politics?.congressSupport) || 0
    };
  }

  changeTone({ key, before, after }) {
    const direction = Math.sign(after - before);
    return direction === METRIC_META[key].goodDirection ? "good" : "bad";
  }

  compactTrendMarkup(change) {
    const delta = Math.round(change.after - change.before);
    const direction = delta > 0 ? "up" : "down";
    return `<span class="dial-trend ${this.changeTone(change)}">
      <i class="trend-arrow ${direction}" aria-hidden="true"></i>
      ${delta > 0 ? "+" : ""}${delta}
    </span>`;
  }

  formatMetricValue(key, value) {
    const meta = METRIC_META[key];
    const suffix = meta.suffixKey ? t(meta.suffixKey) : (meta.suffix || "");
    return `${meta.prefix || ""}${Math.round(value)}${suffix}`;
  }

  showChangeFeedback(changes) {
    clearTimeout(this.changeTimer);
    // 폰에서 다섯 줄이 뜨면 화면의 76% 가 가려져 지도가 사라졌다. 변화가 큰 것부터
    // 세 개만 보여준다. 나머지는 지표 타일에 이미 반영돼 있다.
    const limit = innerWidth <= 850 ? 3 : 5;
    const visible = changes
      .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
      .slice(0, limit);
    this.changeFeedback.innerHTML = `
      <header><span>${t("change.heading")}</span><strong>${t("change.title")}</strong></header>
      <div>${visible.map((change) => {
        const delta = Math.round(change.after - change.before);
        const direction = delta > 0 ? "up" : "down";
        const meta = METRIC_META[change.key];
        return `<article class="${this.changeTone(change)}">
          <i class="trend-arrow ${direction}" aria-hidden="true"></i>
          <span>${t(meta.key)}</span>
          <strong>${delta > 0 ? "+" : ""}${delta}</strong>
          <small>${this.formatMetricValue(change.key, change.before)} → ${this.formatMetricValue(change.key, change.after)} · ${t(delta > 0 ? "common.rose" : "common.fell")}</small>
        </article>`;
      }).join("")}</div>`;
    this.changeFeedback.hidden = false;
    requestAnimationFrame(() => this.changeFeedback.classList.add("show"));
    this.changeTimer = window.setTimeout(() => {
      this.changeFeedback.classList.remove("show");
      window.setTimeout(() => {
        if (!this.changeFeedback.classList.contains("show")) this.changeFeedback.hidden = true;
      }, 300);
    }, 7600);
  }

  dateText(day) {
    const date = new Date(2026, 6, 27 + Math.max(1, day));
    return `${date.getMonth() + 1}.${String(date.getDate()).padStart(2, "0")}`;
  }

  setBrief(text) {
    this.brief.textContent = text;
  }

  pushTicker(text) {
    this.ticker.unshift({
      text,
      time: new Intl.DateTimeFormat(getLang() === "ko" ? "ko-KR" : "en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(new Date())
    });
    this.ticker = this.ticker.slice(0, 6);
    this.tickerText.textContent = this.ticker.map((item) => item.text).join("   ·   ");
  }

  showNewsArchive() {
    if (!this.modal || this.modal.children.length) return;
    const items = this.ticker.length
      ? this.ticker
      : [{ time: t("common.current"), text: this.tickerText.textContent }];
    this.modal.innerHTML = `<section class="game-modal news-modal">
      <div class="modal-top">${uiIconMarkup("news-archive", "modal-icon")}<span>${t("news.eyebrow")}</span><b>${t("news.heading")}</b></div>
      <h2>${t("news.title")}</h2>
      <p>${t("news.help")}</p>
      <div class="news-list">${items.map((item, index) => `
        <article>
          <span>${item.time}</span>
          <div><strong>${t("news.item", { number: String(items.length - index).padStart(2, "0") })}</strong><p>${item.text}</p></div>
        </article>`).join("")}
      </div>
      <div class="modal-actions">
        <button class="primary-button" id="close-news" type="button">${t("news.close")}</button>
      </div>
    </section>`;
    this.modal.querySelector("#close-news").addEventListener("click", () => {
      this.modal.innerHTML = "";
    });
  }

  showCinematicBriefing({
    eyebrow = t("brief.eyebrow"),
    title,
    text,
    detail = "",
    image = "assets/images/briefings/us-national-security-council-v1.webp",
    tone = "ally",
    action = t("brief.action")
  }) {
    if (this.auto) return this.sleep(90);
    return new Promise((resolve) => {
      const finish = () => {
        this.modal.innerHTML = "";
        this.pending = null;
        resolve();
      };
      this.pending = { resolve: finish, fallback: null };
      this.modal.innerHTML = `<section class="game-modal cinematic-briefing ${tone}">
        <figure>
          <img src="${image}" alt="" decoding="async">
          <figcaption><span>${eyebrow}</span><strong>${title}</strong></figcaption>
        </figure>
        <div class="cinematic-copy">
          <p>${text}</p>
          ${detail ? `<aside>${detail}</aside>` : ""}
          <button class="primary-button" id="confirm-briefing" type="button">${action}</button>
        </div>
      </section>`;
      this.modal.querySelector("#confirm-briefing").addEventListener("click", finish, { once: true });
    });
  }

  /**
   * 발언 장면.
   *
   * `delivered` 는 플레이어가 방금 고른 말을 대통령이 실제로 하는 장면이다.
   * 남의 발언을 전달만 하는 경우와 화면을 나눠야 한다 — 같은 틀에 같은 문구면
   * 내가 말한 것인지 남이 말한 것인지 구분이 안 된다.
   */
  showPresidentStatement({ day, statement, previous = null, delivered = false }) {
    if (!statement) return Promise.resolve();
    if (this.auto) return this.sleep(90);
    const role = pick(statement, "speakerRole") || "";
    return new Promise((resolve) => {
      const finish = () => {
        this.modal.innerHTML = "";
        this.pending = null;
        resolve();
      };
      this.pending = { resolve: finish, fallback: null };
      this.modal.innerHTML = `<section class="game-modal president-statement-modal${delivered ? " president-delivery" : ""}">
        <figure class="president-statement-visual" data-speaker="${statement.speaker || "us"}">
          <img src="${SPEAKER_IMAGES[statement.speaker] || SPEAKER_IMAGES.us}" alt="${t("president.imageAlt")}" decoding="async">
          <figcaption>
            <span>${t("president.day", { day })} · ${role || t(`speaker.${statement.speaker || "us"}`)}</span>
            <strong>${pick(statement, "heading") || t("president.headingFallback")}</strong>
          </figcaption>
          ${delivered ? `<span class="president-live-tag">${t("president.liveTag")}</span>` : ""}
          <blockquote class="president-speech-bubble">“${pick(statement, "line")}”</blockquote>
        </figure>
        <div class="president-statement-copy">
          <div>
            <span class="eyebrow">${delivered ? t("president.deliveredEyebrow") : t("president.eyebrow")}</span>
            <p>${pick(statement, "context")}</p>
            ${delivered && statement.delta ? this.deltaMarkup(statement.delta) : ""}
            ${previous ? `<aside><span>${t("president.previous")}</span><q>${pick(previous, "line")}</q></aside>` : ""}
            <small>${statement.verified === false
              ? t("president.sourceReconstructed")
              : t("president.sourceNote", { date: statement.sourceDate || "" })}</small>
          </div>
          <button class="primary-button" id="confirm-president-statement" type="button">${t("president.confirm")}</button>
        </div>
      </section>`;
      this.modal.querySelector("#confirm-president-statement").addEventListener("click", finish, { once: true });
    });
  }

  /**
   * 대통령이 오늘 무슨 말을 할지 고른다.
   *
   * 플레이어가 미국 대통령이므로, 말하는 것 자체가 결정이다. 선택지는 모두
   * 실제로 보도된 발언이며 고른 말에 따라 지표가 달라진다.
   */
  choosePresidentStatement({ day, set }) {
    const options = set.options || [];
    if (!options.length) return Promise.resolve(null);
    if (this.auto) return this.sleep(90).then(() => options[0]);
    return new Promise((resolve) => {
      const finish = (option) => {
        this.modal.innerHTML = "";
        this.pending = null;
        resolve(option);
      };
      this.pending = { resolve: finish, fallback: options[0] };
      this.modal.innerHTML = `<section class="game-modal president-statement-modal president-choice-modal">
        <figure class="president-statement-visual" data-speaker="us">
          <img src="${SPEAKER_IMAGES.us}" alt="${t("president.imageAlt")}" decoding="async">
          <figcaption>
            <span>${t("president.day", { day })} · ${pick(set, "speakerRole")}</span>
            <strong>${pick(set, "heading")}</strong>
          </figcaption>
        </figure>
        <div class="president-statement-copy">
          <div>
            <span class="eyebrow">${t("president.choosePrompt")}</span>
            <p>${pick(set, "prompt")}</p>
            <div class="president-choice-grid">
              ${options.map((option, index) => `
                <button type="button" class="decision-card" data-say="${index}">
                  <span class="card-category">${pick(option, "tone")}</span>
                  <strong>“${pick(option, "line")}”</strong>
                  <span>${pick(option, "context")}</span>
                  ${this.deltaMarkup(option.delta)}
                  <small>${option.verified === false
                    ? t("president.sourceReconstructed")
                    : t("president.sourceNote", { date: option.sourceDate || "" })}</small>
                </button>`).join("")}
            </div>
          </div>
        </div>
      </section>`;
      this.modal.querySelectorAll("[data-say]").forEach((button) => {
        button.addEventListener("click", () => finish(options[Number(button.dataset.say)]));
      });
    });
  }

  runRtsBattle(mission, {
    budget = 0,
    congressSupport = 39,
    partySupport = 58,
    approval = 44,
    battleContext = {}
  } = {}) {
    return new Promise((resolve) => {
      const url = new URL("rts-combat.html", location.href);
      url.searchParams.set("v", RTS_RUNTIME_VERSION);
      url.searchParams.set("embedded", "1");
      url.searchParams.set("campaign", "mission");
      url.searchParams.set("scenario", mission.scenario || mission.id);
      // 전투 화면은 자체 사전을 쓰므로 현재 언어만 넘겨주면 된다.
      url.searchParams.set("lang", getLang());
      url.searchParams.set("budget", String(Math.max(0, Math.round(budget))));
      url.searchParams.set("congress", String(Math.round(congressSupport)));
      url.searchParams.set("party", String(Math.round(partySupport)));
      url.searchParams.set("approval", String(Math.round(approval)));
      url.searchParams.set("day", String(Math.max(1, Math.round(battleContext.day || 1))));
      url.searchParams.set("difficulty", String(Math.max(1, Math.min(5, Math.round(battleContext.difficulty || 1)))));
      url.searchParams.set("variant", String(Math.max(0, Math.min(2, Math.round(battleContext.variant || 0)))));
      url.searchParams.set("repeat", String(Math.max(0, Math.round(battleContext.repeatCount || 0))));
      url.searchParams.set("wins", String(Math.max(0, Math.round(battleContext.wins || 0))));
      url.searchParams.set("losses", String(Math.max(0, Math.round(battleContext.losses || 0))));
      url.searchParams.set("streak", String(Math.max(0, Math.round(battleContext.winStreak || 0))));
      url.searchParams.set("esc", String(Math.max(1, Math.min(5, Math.round(battleContext.escalation || 3)))));
      url.searchParams.set("stance", battleContext.stance || "HARDLINE");
      if (battleContext.counterType) url.searchParams.set("counter", battleContext.counterType);
      if (battleContext.seed) url.searchParams.set("seed", String(Math.round(battleContext.seed)));
      const qaOutcome = new URLSearchParams(location.search).get("rtsqa");
      if (["campaign-success", "campaign-failure"].includes(qaOutcome)) {
        url.searchParams.set("qa", qaOutcome);
      }
      this.modal.innerHTML = `<section class="embedded-rts-shell">
        <iframe
          class="embedded-rts-frame"
          title="${t("rts.frameTitle", { title: pick(mission, "title") })}"
          src="${url.href}"
          allow="autoplay"
        ></iframe>
        <button class="embedded-rts-exit" type="button">${t("rts.abort")}</button>
      </section>`;
      const frame = this.modal.querySelector(".embedded-rts-frame");
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        this.modal.innerHTML = "";
        resolve(result);
      };
      const onMessage = (event) => {
        if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
        if (event.data?.type !== "hormuz-rts-result") return;
        finish(event.data.result);
      };
      window.addEventListener("message", onMessage);
      this.modal.querySelector(".embedded-rts-exit").addEventListener("click", () => {
        finish({
          success: false,
          aborted: true,
          destroyed: 0,
          budgetUsed: 0,
          supplementalBudget: 0,
          politics: { congressSupport, partySupport, approvalDelta: -2, intlDelta: 0 }
        });
      });
    });
  }

  showCampaignOffice(state, campaign, { update }) {
    if (!campaign || !this.modal || this.modal.children.length) return;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
    const close = () => { this.modal.innerHTML = ""; };
    const renderOverview = () => {
      const available = Math.max(
        0,
        state.politics.authorizedBudget - state.politics.spentBudget
      );
      const operations = [...(campaign.operations || [])]
        .sort((a, b) => a.order - b.order);
      this.modal.innerHTML = `<section class="game-modal campaign-office-modal">
        <span class="eyebrow">${t("office.eyebrow")}</span>
        <h2>${t("office.heading")}</h2>
        <p>${t("office.intro")}</p>
        <div class="budget-ledger">
          <div>${uiIconMarkup("ledger-authorized", "ledger-icon")}<span>${t("office.authorized")}</span><strong>$${state.politics.authorizedBudget}M</strong></div>
          <div>${uiIconMarkup("ledger-spent", "ledger-icon")}<span>${t("office.spent")}</span><strong>$${state.politics.spentBudget}M</strong></div>
          <div>${uiIconMarkup("ledger-available", "ledger-icon")}<span>${t("office.available")}</span><strong>$${available}M</strong></div>
        </div>
        <div class="politics-ledger">
          <span>${uiIconMarkup("politics-congress", "ledger-icon")}${t("office.congressSupport")} <b>${state.politics.congressSupport}%</b></span>
          <span>${t("office.partySupport")} <b>${state.politics.partySupport}%</b></span>
          <span>${uiIconMarkup("politics-approval", "ledger-icon")}${t("office.publicSupport")} <b>${Math.round(state.dials.approval)}%</b></span>
          <span>${t("office.forcedCount")} <b>${state.politics.forcedAppropriations}${t("office.forcedUnit")}</b></span>
        </div>
        <div class="operation-roadmap">${operations.map((operation) => {
          const completed = state.campaign.completedOperations.includes(operation.id);
          const failed = state.campaign.failedOperations.includes(operation.id);
          const status = completed
            ? t("office.statusDone")
            : failed
              ? t("office.statusRetry")
              : operation.implementation === "playable"
                ? t("office.statusLive")
                : operation.implementation === "next"
                  ? t("office.statusNext")
                  : t("office.statusPlanned");
          return `<article class="${completed ? "completed" : failed ? "failed" : ""}">
            ${uiIconMarkup(`op-${operation.scenario || operation.id}`, "operation-icon")}
            <span>${t("office.operationLabel", { order: String(operation.order).padStart(2, "0") })} · ${status}</span>
            <strong>${pick(operation, "title")}</strong>
            <p>${pick(operation, "objective")}</p>
            <small>${t("office.recommended", { budget: operation.budgetRecommended })} · ${pick(operation, "politicalStake")}</small>
          </article>`;
        }).join("")}</div>
        <p class="budget-note">${pick(campaign.budget, "note")}</p>
        <div class="modal-actions">
          <button class="ghost-button" id="close-campaign-office" type="button">${t("office.close")}</button>
          <button class="primary-button" id="open-appropriation" type="button">${t("office.openAppropriation")}</button>
        </div>
      </section>`;
      this.modal.querySelector("#close-campaign-office").addEventListener("click", close);
      this.modal.querySelector("#open-appropriation").addEventListener("click", renderCongress);
    };

    const renderCongress = () => {
      const used = new Set();
      let support = state.politics.congressSupport;
      let party = state.politics.partySupport;
      const initialSupport = support;
      const initialParty = party;
      let approvalDelta = 0;
      let intlDelta = 0;
      let message = t("congress.hint");
      const draw = () => {
        this.modal.innerHTML = `<section class="game-modal congress-modal">
          <span class="eyebrow">${t("congress.eyebrow")}</span>
          <figure class="congress-visual">
            <img src="assets/images/politics/congress-emergency-session-v1.webp" alt="${t("congress.imageAlt")}" decoding="async">
            <figcaption>${t("congress.caption")}</figcaption>
          </figure>
          <h2>${t("congress.heading")}</h2>
          <p>${t("congress.intro", { amount: campaign.budget.supplementalRequest })}</p>
          <div class="congress-meter">
            <div><span>${t("congress.currentSupport")}</span><strong>${support}%</strong></div>
            <i><b style="width:${support}%"></b></i>
            <div><span>${t("congress.threshold")}</span><strong>${campaign.congress.passThreshold}%</strong></div>
          </div>
          <div class="congress-live-change">
            <span class="${support >= initialSupport ? "good" : "bad"}">${t("congress.shortCongress")} ${support >= initialSupport ? "+" : ""}${support - initialSupport} · ${support}%</span>
            <span class="${party >= initialParty ? "good" : "bad"}">${t("congress.shortParty")} ${party >= initialParty ? "+" : ""}${party - initialParty} · ${party}%</span>
            <span class="${approvalDelta >= 0 ? "good" : "bad"}">${t("congress.shortPublic")} ${approvalDelta >= 0 ? "+" : ""}${approvalDelta}</span>
            <span class="${intlDelta >= 0 ? "good" : "bad"}">${t("congress.shortIntl")} ${intlDelta >= 0 ? "+" : ""}${intlDelta}</span>
          </div>
          <div class="congress-actions">${campaign.congress.actions.map((action) => `
            <button type="button" data-lobby="${action.id}" ${used.has(action.id) ? "disabled" : ""}>
              <strong>${pick(action, "name")}</strong>
              <span>${pick(action, "desc")}</span>
              <small><b class="change-chip good">${t("congress.shortCongress")} +${action.congress}</b><b class="change-chip ${action.party >= 0 ? "good" : "bad"}">${t("congress.shortParty")} ${action.party >= 0 ? "+" : ""}${action.party}</b></small>
            </button>`).join("")}
          </div>
          <p class="congress-message">${message}</p>
          <div class="modal-actions congress-vote-actions">
            <button class="ghost-button" id="cancel-appropriation" type="button">${t("congress.cancel")}</button>
            <button class="ghost-button danger-action" id="force-appropriation" type="button">${t("congress.force")}</button>
            <button class="primary-button" id="vote-appropriation" type="button">${t("congress.vote")}</button>
          </div>
        </section>`;
        this.modal.querySelectorAll("[data-lobby]").forEach((button) => {
          button.addEventListener("click", () => {
            const action = campaign.congress.actions.find(
              (item) => item.id === button.dataset.lobby
            );
            if (!action || used.has(action.id)) return;
            used.add(action.id);
            support = clamp(support + action.congress, 0, 100);
            party = clamp(party + action.party, 0, 100);
            approvalDelta += Number(action.approval) || 0;
            intlDelta += Number(action.intl) || 0;
            message = t("congress.applied", { name: pick(action, "name"), support });
            draw();
          });
        });
        this.modal.querySelector("#cancel-appropriation").addEventListener("click", renderOverview);
        this.modal.querySelector("#vote-appropriation").addEventListener("click", () => {
          if (support < campaign.congress.passThreshold) {
            update((current) => {
              current.politics.congressSupport = clamp(support - 3, 0, 100);
              current.dials.approval = clamp(current.dials.approval - 2, 0, 100);
              current.log.push(t("congress.rejectedLog", { support }));
            });
            this.render(state);
            this.pushTicker(t("congress.rejectedTicker", { support }));
            renderOverview();
            return;
          }
          update((current) => {
            current.politics.authorizedBudget += campaign.budget.supplementalRequest;
            current.politics.supplementalBudget += campaign.budget.supplementalRequest;
            current.politics.appropriationsPassed += 1;
            current.politics.congressSupport = support;
            current.politics.partySupport = party;
            current.dials.approval = clamp(current.dials.approval + approvalDelta + 1, 0, 100);
            current.dials.intl = clamp(current.dials.intl + intlDelta, 0, 100);
            current.log.push(t("congress.passedLog", { amount: campaign.budget.supplementalRequest }));
          });
          this.render(state);
          this.pushTicker(t("congress.passedTicker", { amount: campaign.budget.supplementalRequest }));
          renderOverview();
        });
        this.modal.querySelector("#force-appropriation").addEventListener("click", () => {
          const penalty = campaign.congress.override;
          update((current) => {
            current.politics.authorizedBudget += campaign.budget.supplementalRequest;
            current.politics.supplementalBudget += campaign.budget.supplementalRequest;
            current.politics.forcedAppropriations += 1;
            current.politics.congressSupport = clamp(
              current.politics.congressSupport + penalty.congress,
              0,
              100
            );
            current.politics.partySupport = clamp(
              current.politics.partySupport + penalty.party,
              0,
              100
            );
            current.dials.approval = clamp(
              current.dials.approval + penalty.approval,
              0,
              100
            );
            current.log.push(t("congress.forcedLog", { amount: campaign.budget.supplementalRequest }));
          });
          this.render(state);
          this.pushTicker(t("congress.forcedTicker"));
          renderOverview();
        });
      };
      draw();
    };
    renderOverview();
  }

  choose({ kind, title, subtitle, options, timeout, autoIndex = 0 }) {
    this.decisions.classList.add("open");
    this.scene?.setViewLift?.(true);
    return new Promise((resolve) => {
      let closed = false;
      const finish = (option) => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        this.scene?.setViewLift?.(false);
    this.decisions.classList.remove("open");
        this.decisions.innerHTML = "";
        this.pending = null;
        resolve(option);
      };
      const fallback = options[Math.max(0, Math.min(options.length - 1, autoIndex))];
      this.pending = { resolve: finish, fallback };
      this.decisions.innerHTML = `
        <div class="decision-head">
          <div><span class="eyebrow">${t(kind === "urgent" ? "decision.urgent" : "decision.council")}</span>
          <h2>${title}</h2><p>${subtitle}</p></div>
          <div class="decision-timer"><span id="decision-seconds">${Math.ceil(timeout / 1000)}</span><small>${t("decision.timerLabel")}</small></div>
        </div>
        <div class="decision-options">${options.map((option, index) => `
          <button class="decision-card" data-choice="${index}">
            <span class="card-index">0${index + 1}</span>
            <span class="card-category">${categoryIconMarkup(
              option.cat || (kind === "urgent" ? "ROE" : "POLICY")
            )}${t(CATEGORY_KEYS[option.cat] || (kind === "urgent" ? "cat.ROE" : "cat.POLICY"))}</span>
            <strong>${pick(option, "name")}</strong>
            <span>${pick(option, "desc")}</span>
            ${this.deltaMarkup(option.delta)}
          </button>`).join("")}
        </div>`;
      this.decisions.querySelectorAll("[data-choice]").forEach((button) => {
        button.addEventListener("click", () => finish(options[Number(button.dataset.choice)]));
      });
      const started = performance.now();
      const interval = setInterval(() => {
        const remaining = Math.max(0, timeout - (performance.now() - started));
        const seconds = this.decisions.querySelector("#decision-seconds");
        if (seconds) seconds.textContent = Math.ceil(remaining / 1000);
        if (remaining <= 0 || this.auto) finish(fallback);
      }, this.auto ? 80 : 100);
    });
  }

  deltaMarkup(delta = {}) {
    const names = {
      transit: t("dialShort.transit"), oil: t("dialShort.oil"), approval: t("dialShort.approval"),
      intl: t("dialShort.intl"), ammo: t("dialShort.ammo"), esc: t("dialShort.esc")
    };
    const entries = Object.entries(delta).filter(([key]) => names[key]).slice(0, 4);
    if (!entries.length) return "";
    return `<span class="delta-row">${entries.map(([key, value]) => {
      const direction = value > 0 ? "up" : "down";
      const tone = value > 0
        ? (key === "oil" || key === "esc" ? "bad" : "good")
        : (key === "oil" || key === "esc" ? "good" : "bad");
      return `<b class="${tone}"><i class="trend-arrow ${direction}" aria-hidden="true"></i>${names[key]} ${value > 0 ? "+" : ""}${value}<em>${t(value > 0 ? "common.up" : "common.down")}</em></b>`;
    }).join("")}</span>`;
  }

  chooseMissionAsset(mission, assets, { timeout = 180000 } = {}) {
    const options = assets.map((asset) => ({
      ...asset,
      cat: "ASSET",
      desc: t("mission.assetDesc", {
        role: pick(asset, "role"), weapon: pick(asset, "weapon"),
        speed: asset.speed, armor: asset.armor
      }),
      delta: {}
    }));
    return this.choose({
      kind: "asset",
      title: mission.title,
      subtitle: t("mission.subtitle", { brief: pick(mission, "brief") }),
      options,
      timeout,
      autoIndex: 1 < options.length ? 1 : 0
    });
  }

  beginMission(mission, asset, { onControl, onFire }) {
    this.root.classList.add("mission-active");
    const abort = new AbortController();
    const signal = abort.signal;
    this.modal.innerHTML = `<section class="mission-hud" data-testid="mission-hud">
      <div class="mission-objective">
        <span>${mission.kicker}</span>
        <strong>${mission.title}</strong>
        <p>${mission.brief}</p>
        <div class="mission-progress"><i id="mission-progress-fill"></i></div>
        <div class="mission-counters">
          <b id="mission-score">0 / ${mission.targetCount}</b>
          <b id="mission-time">${Math.ceil(mission.duration / 1000)}</b>
        </div>
      </div>
      <div class="mission-telemetry">
        <span>${t("mission.pilotedAsset")}</span><strong>${pick(asset, "name")}</strong>
        <small>${asset.weapon}</small>
        <div><i>${t("mission.airframe")}</i><b id="mission-health">${asset.armor}</b></div>
        <div><i>${t("mission.ammo")}</i><b id="mission-ammo">${asset.ammo}</b></div>
        <div><i>${t("mission.target")}</i><b id="mission-lock">${t("common.searching")}</b></div>
      </div>
      <div class="mission-reticle" aria-hidden="true"><i></i><b>LOCK</b></div>
      <div class="mission-help">${t("mission.help")}</div>
      <div class="mission-drive" aria-label="${t("mission.driveAria")}">
        <button data-control="throttle" aria-label="${t("mission.forward")}">▲</button>
        <button data-control="turnLeft" aria-label="${t("mission.turnLeft")}">◀</button>
        <button data-control="brake" aria-label="${t("mission.brake")}">▼</button>
        <button data-control="turnRight" aria-label="${t("mission.turnRight")}">▶</button>
      </div>
      <button class="mission-fire" id="mission-fire" type="button">
        <span>WEAPON FREE</span><strong>${t("mission.fire")}</strong><small>${pick(asset, "weapon")}</small>
      </button>
    </section>`;

    this.modal.querySelectorAll("[data-control]").forEach((button) => {
      const action = button.dataset.control;
      const press = (event) => {
        event.preventDefault();
        button.classList.add("pressed");
        onControl(action, true);
      };
      const release = (event) => {
        event.preventDefault();
        button.classList.remove("pressed");
        onControl(action, false);
      };
      button.addEventListener("pointerdown", press, { signal });
      button.addEventListener("pointerup", release, { signal });
      button.addEventListener("pointercancel", release, { signal });
      button.addEventListener("lostpointercapture", release, { signal });
    });
    this.modal.querySelector("#mission-fire").addEventListener("pointerdown", (event) => {
      event.preventDefault();
      onFire();
    }, { signal });

    const update = (status) => {
      const ratio = Math.max(0, Math.min(1, status.destroyed / mission.targetCount));
      const fill = this.modal.querySelector("#mission-progress-fill");
      const score = this.modal.querySelector("#mission-score");
      const time = this.modal.querySelector("#mission-time");
      const health = this.modal.querySelector("#mission-health");
      const ammo = this.modal.querySelector("#mission-ammo");
      const lock = this.modal.querySelector("#mission-lock");
      const reticle = this.modal.querySelector(".mission-reticle");
      if (fill) fill.style.width = `${ratio * 100}%`;
      if (score) score.textContent = `${status.destroyed} / ${mission.targetCount}`;
      if (time) {
        const seconds = Math.max(0, Math.ceil(status.remaining / 1000));
        time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      }
      if (health) health.textContent = Math.max(0, Math.round(status.health));
      if (ammo) ammo.textContent = status.ammo;
      if (lock) lock.textContent = status.locked ? "LOCK" : t("common.searching");
      reticle?.classList.toggle("locked", Boolean(status.locked));
    };
    const close = () => {
      abort.abort();
      this.root.classList.remove("mission-active");
      this.modal.innerHTML = "";
    };
    return { update, close };
  }

  async showMissionResult(mission, result, duration = 2200) {
    const targetCount = Number(result.targetCount) || mission.targetCount;
    this.report.innerHTML = `<div class="day-report mission-result ${result.success ? "success" : "failure"}">
      <span>${result.success ? "MISSION ACCOMPLISHED" : "MISSION INCOMPLETE"}</span>
      <strong>${pick(mission, "title")} · ${result.destroyed}/${targetCount}</strong>
    </div>`;
    this.report.classList.add("show");
    await this.sleep(duration);
    this.report.classList.remove("show");
    this.report.innerHTML = "";
  }

  negotiation(state, { fast = false } = {}) {
    if (fast || this.auto) return Promise.resolve([0, 0, 0, 0]);
    const agenda = [
      {
        title: t("nego.missiles.title"),
        question: t("nego.missiles.question"),
        options: [
          [t("nego.missiles.o1"), t("nego.missiles.o1d")],
          [t("nego.missiles.o2"), t("nego.missiles.o2d")],
          [t("nego.missiles.o3"), t("nego.missiles.o3d")]
        ]
      },
      {
        title: t("nego.mines.title"),
        question: t("nego.mines.question"),
        options: [
          [t("nego.mines.o1"), t("nego.mines.o1d")],
          [t("nego.mines.o2"), t("nego.mines.o2d")],
          [t("nego.mines.o3"), t("nego.mines.o3d")]
        ]
      },
      {
        title: t("nego.sanctions.title"),
        question: t("nego.sanctions.question"),
        options: [
          [t("nego.sanctions.o1"), t("nego.sanctions.o1d")],
          [t("nego.sanctions.o2"), t("nego.sanctions.o2d")],
          [t("nego.sanctions.o3"), t("nego.sanctions.o3d")]
        ]
      },
      {
        title: t("nego.security.title"),
        question: t("nego.security.question"),
        options: [
          [t("nego.security.o1"), t("nego.security.o1d")],
          [t("nego.security.o2"), t("nego.security.o2d")],
          [t("nego.security.o3"), t("nego.security.o3d")]
        ]
      }
    ];
    let terms = [...state.negotiation.terms];
    return new Promise((resolve) => {
      let step = 0;
      let selected = Number.isInteger(terms[0]) ? terms[0] : 1;
      const finish = (result) => {
        this.modal.innerHTML = "";
        resolve(result);
      };
      const renderReview = () => {
        const power = negotiationPower(state);
        const demand = negotiationDemand(terms, state);
        const margin = power - demand;
        this.modal.innerHTML = `<section class="game-modal negotiation-modal negotiation-review">
          <figure class="negotiation-visual">
            <img src="assets/images/briefings/oman-backchannel-v1.webp" alt="${t("nego.imageAlt")}" decoding="async">
            <figcaption>${t("nego.finalCaption")}</figcaption>
          </figure>
          <h2>${t(margin >= 0 ? "nego.signable" : "nego.overreach")}</h2>
          <p>${margin >= 0
            ? t("nego.marginLeft", { margin })
            : t("nego.marginOver", { margin: Math.abs(margin) })}</p>
          <div class="power-compare">
            <div><span>${t("nego.usPower")}</span><strong>${power}</strong></div>
            <i class="${power >= demand ? "ready" : ""}"></i>
            <div><span>${t("nego.demandLevel")}</span><strong>${demand}</strong></div>
          </div>
          <div class="agreement-summary">${agenda.map((item, index) => `
            <article><span>${index + 1}. ${item.title}</span><strong>${item.options[terms[index]][0]}</strong></article>
          `).join("")}</div>
          <div class="negotiation-status ${margin >= 0 ? "good" : "bad"}">
            <strong>${t(margin >= 0 ? "nego.canAgree" : "nego.breakRisk")}</strong>
            <span>${margin >= 0 ? t("nego.surplus", { margin }) : t("nego.excess", { margin: Math.abs(margin) })}</span>
          </div>
          <div class="modal-actions">
            <button class="ghost-button" id="revise-terms" type="button">${t("nego.revise")}</button>
            <button class="ghost-button" id="continue-war" type="button">${t("nego.abort")}</button>
            <button class="primary-button" id="submit-terms" type="button" ${power < demand ? "disabled" : ""}>${t("nego.submit")}</button>
          </div>
        </section>`;
        this.modal.querySelector("#revise-terms").addEventListener("click", () => {
          step = 0;
          selected = terms[0];
          renderStep();
        });
        this.modal.querySelector("#continue-war").addEventListener("click", () => finish(null));
        this.modal.querySelector("#submit-terms")?.addEventListener("click", () => finish(terms));
      };
      const renderStep = () => {
        const item = agenda[step];
        const previewTerms = [...terms];
        previewTerms[step] = selected;
        const power = negotiationPower(state);
        const demand = negotiationDemand(previewTerms, state);
        const margin = power - demand;
        this.modal.innerHTML = `<section class="game-modal negotiation-modal negotiation-step">
          <figure class="negotiation-visual">
            <img src="assets/images/briefings/oman-backchannel-v1.webp" alt="${t("nego.imageAlt")}" decoding="async">
            <figcaption>${t("nego.stepCaption", { step: step + 1, total: agenda.length })}</figcaption>
          </figure>
          <div class="negotiation-progress">${agenda.map((_, index) => `<i class="${index <= step ? "done" : ""}"></i>`).join("")}</div>
          <span class="eyebrow">${t("nego.stepEyebrow", { step: step + 1, title: item.title })}</span>
          <h2>${item.question}</h2>
          <p>${t("nego.stepHelp")}</p>
          <div class="negotiation-choice-grid">${item.options.map((option, index) => `
            <button type="button" data-negotiation-choice="${index}" class="${selected === index ? "selected" : ""}">
              <strong>${option[0]}</strong><span>${option[1]}</span>
              <small>${t("nego.demandStep", { index: index + 1 })}</small>
            </button>`).join("")}</div>
          <div class="negotiation-live ${margin >= 0 ? "good" : "bad"}">
            <div><span>${t("nego.ourPower")}</span><strong>${power}</strong></div>
            <div><span>${t("nego.currentDemand")}</span><strong>${demand}</strong></div>
            <p>${margin >= 0
              ? t("nego.canAgreeMargin", { margin })
              : t("nego.breakRiskOver", { margin: Math.abs(margin) })}</p>
          </div>
          <div class="modal-actions">
            ${step ? `<button class="ghost-button" id="previous-agenda" type="button">${t("nego.previousAgenda")}</button>` : `<button class="ghost-button" id="continue-war" type="button">${t("nego.abort")}</button>`}
            <button class="primary-button" id="next-agenda" type="button">${t(step === agenda.length - 1 ? "nego.confirmFinal" : "nego.nextWithChoice")}</button>
          </div>
        </section>`;
        this.modal.querySelectorAll("[data-negotiation-choice]").forEach((button) => {
          button.addEventListener("click", () => {
            selected = Number(button.dataset.negotiationChoice);
            renderStep();
          });
        });
        this.modal.querySelector("#continue-war")?.addEventListener("click", () => finish(null));
        this.modal.querySelector("#previous-agenda")?.addEventListener("click", () => {
          terms[step] = selected;
          step -= 1;
          selected = terms[step];
          renderStep();
        });
        this.modal.querySelector("#next-agenda").addEventListener("click", () => {
          terms[step] = selected;
          if (step === agenda.length - 1) {
            renderReview();
            return;
          }
          step += 1;
          selected = terms[step];
          renderStep();
        });
      };
      renderStep();
    });
  }

  async showDayReport(state, duration) {
    this.report.innerHTML = `<div class="day-report">
      <span>${t("report.dayEnd", { day: state.day })}</span>
      <strong>${t("report.daySummary", {
        transit: state.dials.transit, oil: state.dials.oil, esc: state.dials.esc
      })}</strong>
    </div>`;
    this.report.classList.add("show");
    await this.sleep(duration);
    this.report.classList.remove("show");
    this.report.innerHTML = "";
  }

  showEnding(state) {
    const ended = state.ended;
    const improved = saveBest({
      score: ended.score, grade: ended.grade, endingId: ended.endingId,
      endDay: ended.endDay, transit: state.dials.transit, at: new Date().toISOString()
    });
    return new Promise((resolve) => {
      this.modal.innerHTML = `<section class="game-modal ending-modal" data-testid="ending">
        ${uiIconMarkup("ending-grade", "ending-icon")}<span class="ending-grade">${ended.grade}</span>
        <span class="eyebrow">HORMUZ · AFTER ACTION REPORT</span>
        <h1>${pick(ended, "name")}</h1>
        <p>${pick(ended, "tagline")}</p>
        <div class="final-score"><small>${t("report.finalScore")}</small><strong>${ended.score.toLocaleString()}</strong>
          ${improved ? `<b>${t("report.personalBest")}</b>` : ""}</div>
        <div class="score-parts">${Object.entries(ended.parts).map(([key, value]) =>
          `<div><span>${t({
            speed: "dialShort.speed", oil: "dialShort.oil", appr: "dialShort.approval",
            intl: "dialShort.intl", transit: "dialShort.transit", esc: "dialShort.esc"
          }[key])}</span><b>${value}</b></div>`
        ).join("")}</div>
        <div class="modal-actions">
          <button class="ghost-button" id="review-map">${t("report.reviewMap")}</button>
          <button class="primary-button" id="restart-game">${t("report.restart")}</button>
        </div>
      </section>`;
      this.modal.querySelector("#review-map").addEventListener("click", () => {
        this.modal.innerHTML = "";
        resolve("review");
      });
      this.modal.querySelector("#restart-game").addEventListener("click", () => resolve("restart"));
    });
  }
}
