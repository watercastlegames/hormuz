import { mulberry32 } from "./rng.js";
import {
  DAILY_DECISION_TRACKS, curatePolicyTrack, missionScenarioId
} from "./policy.js";
import { chooseIranEvent } from "./iran_ai.js";
import {
  applyDelta, checkTerminalEnding, finalizeEnding, MAX_CAMPAIGN_DAY,
  MIN_SUCCESS_DAY, negotiatedEndingId, resolveDay, resolveNegotiation
} from "./rules.js";
import { saveCheckpoint } from "./state.js";
import { t, pick } from "./i18n.js";

export class GameDirector {
  constructor({
    state, update, cards, events, endings, missions, campaign, presidentStatements,
    ui, scene, fast = false, debugMission = null
  }) {
    this.state = state;
    this.update = update;
    this.cards = cards;
    this.events = events;
    this.endings = endings;
    this.missionData = missions;
    this.campaignData = campaign;
    this.presidentStatements = presidentStatements?.statements || [];
    this.presidentChoiceSets = presidentStatements?.choiceSets || [];
    this.ui = ui;
    this.scene = scene;
    this.fast = fast;
    this.debugMission = debugMission;
    this.random = mulberry32(state.seed);
    this.runToken = 0;
    this.minimumSuccessDay = MIN_SUCCESS_DAY;
    this.maxCampaignDay = MAX_CAMPAIGN_DAY;
    this.dailyDecisionTracks = DAILY_DECISION_TRACKS;
  }

  stop() {
    this.runToken++;
    this.ui.cancelPending?.();
  }

  async start() {
    const token = ++this.runToken;
    if (this.state.day < 1) {
      this.update((state) => {
        state.day = 1;
        state.phase = "DAY_BRIEF";
        state.resume = {
          stage: "brief", day: 1, replayIndex: state.replay.choices.length,
          policy: null, policyStep: 0, eventId: ""
        };
      });
      saveCheckpoint(t("director.dayBrief", { day: 1 }));
    } else if (!this.state.resume || this.state.resume.day !== this.state.day) {
      this.update((state) => {
        state.phase = "DAY_BRIEF";
        state.resume = {
          stage: "brief",
          day: state.day,
          replayIndex: state.replay.choices.length,
          policy: null,
          policyStep: 0,
          eventId: ""
        };
      });
      saveCheckpoint(t("director.dayBrief", { day: this.state.day }));
    }
    if (this.debugMission) {
      const aliases = {
        surface: "surface_swarm",
        swarm: "surface_swarm",
        defense: "air_defense",
        intercept: "air_defense",
        mine: "mine_clearance",
        minesweep: "mine_clearance",
        strike: "strategic_strike",
        bombrun: "strategic_strike",
        pickaxe: "pickaxe_strike",
        bunker: "pickaxe_strike",
        nuclear: "pickaxe_strike",
        rescue: "tanker_rescue",
        tanker: "tanker_rescue",
        large: "large_fleet_battle",
        fleet: "large_fleet_battle",
        carrier: "large_fleet_battle"
      };
      const missionId = aliases[this.debugMission] || this.debugMission;
      this.scene.setDay(this.state);
      this.ui.render(this.state);
      this.ui.setBrief(t("director.debugBrief"));
      await this.handleMission(missionId, token);
      this.update((state) => { state.flags.introMissionDone = true; });
      this.debugMission = null;
    }
    while (!this.state.ended && token === this.runToken) {
      await this.runDay(token);
    }
  }

  async runDay(token) {
    const state = this.state;
    this.scene.setDay(state);
    this.ui.render(state);
    let stage = state.resume?.day === state.day ? state.resume.stage : "brief";
    let policy = state.resume?.policy || null;
    let policyStep = Math.max(0, Math.min(3, Number(state.resume?.policyStep) || 0));

    if (stage === "brief") {
      this.update((current) => {
        current.phase = "DAY_BRIEF";
        current.resume = this.resumePoint("brief");
        const entry = t("director.dayBrief", { day: current.day });
        if (current.log[current.log.length - 1] !== entry) current.log.push(entry);
        current.log = current.log.slice(-120);
      });
      saveCheckpoint(t("director.dayBrief", { day: state.day }));
      const briefing = this.dailyBrief(state);
      this.ui.setBrief(briefing);
      await this.ui.showCinematicBriefing({
        eyebrow: t("director.briefEyebrow", { day: state.day }),
        title: this.actName(state.act),
        text: briefing,
        detail: t("director.briefDetail", {
          transit: Math.round(state.dials.transit),
          oil: Math.round(state.dials.oil),
          esc: Math.round(state.dials.esc)
        }),
        image: "assets/images/briefings/us-national-security-council-v1.webp",
        tone: "ally",
        action: t("director.briefAction")
      });
      if (token !== this.runToken) return;

      /* 아침 발언. 예전에는 발언이 하루의 맨 끝(결정 3회·이란 대응 뒤)에만 있어서
         하루를 끝까지 진행하기 전에는 한 번도 볼 수 없었다. 브리핑 직후로 하나 당겨
         첫날 첫 화면부터 누가 무슨 말을 하는지 보이게 한다. */
      const morning = this.statementForSlot(state.day, 0);
      if (morning) {
        const spoken = await this.deliverStatement(state.day, morning, token);
        if (token !== this.runToken) return;
        if (spoken) this.ui.pushTicker(t("director.presidentTicker", { line: pick(spoken, "line") }));
      }

      this.update((current) => {
        current.phase = "DAY_POLICY";
        current.resume = this.resumePoint("policy", { policy: null, policyStep: 0 });
      });
      saveCheckpoint(t("director.checkpointPolicy", { day: state.day }));
      stage = "policy";
    }

    // v130 이전 체크포인트는 선택 확정 뒤 실행을 기다리는 단일 정책을 담고 있다.
    // 해당 정책을 오늘의 첫 결정으로 한 번만 반영한 뒤 새 3단계 구조로 이어간다.
    if (stage === "policy_execute" && policy) {
      const legacy = this.policySnapshot(policy);
      const applied = { ...legacy, delta: this.scaledPolicyDelta(legacy) };
      policy = this.combineDailyPolicy(null, applied);
      policyStep = 1;
      this.update((current) => {
        current.phase = "DAY_EXEC";
        applyDelta(current, applied.delta);
        if (applied.flag) current.flags[applied.flag] = true;
        current.flags.history.push(applied.id);
        current.log.push(`${applied.name}: ${applied.desc}`);
        current.resume = this.resumePoint("policy", { policy, policyStep });
      });
      saveCheckpoint(t("director.checkpointLegacy", { day: state.day, name: applied.name }));
      this.scene.playPreset(applied.fx, state);
      this.ui.pushTicker(t("director.legacyTicker", { name: applied.name }));
      if (applied.mission) await this.handleMission(this.missionIdFor(applied.mission), token);
      if (applied.negotiation) {
        const ended = await this.handleNegotiation(token);
        if (ended || token !== this.runToken) return;
      }
      stage = "policy";
    } else if (stage === "policy_execute") {
      stage = "policy";
    }

    if (stage === "policy") {
      for (let index = policyStep; index < DAILY_DECISION_TRACKS.length; index++) {
        const track = DAILY_DECISION_TRACKS[index];
        const choices = curatePolicyTrack(state, this.cards, this.random, track);
        const selected = await this.ui.choose({
          kind: "policy",
          title: `${track.stepLabel} · ${t(track.titleKey)}`,
          subtitle: `DAY ${state.day} · ${t(track.subtitleKey)}`,
          options: choices,
          timeout: this.fast ? 350 : 180000,
          autoIndex: 0
        });
        if (token !== this.runToken || !selected) return;

        const snapshot = this.policySnapshot(selected);
        const applied = { ...snapshot, delta: this.scaledPolicyDelta(snapshot) };
        policy = this.combineDailyPolicy(policy, applied);
        policyStep = index + 1;
        this.update((current) => {
          current.phase = "DAY_EXEC";
          applyDelta(current, applied.delta);
          if (applied.flag) current.flags[applied.flag] = true;
          current.flags.history.push(applied.id);
          current.log.push(`${t(track.titleKey)} · ${applied.name}: ${applied.desc}`);
          current.resume = this.resumePoint("policy", { policy, policyStep });
        });
        saveCheckpoint(t("director.checkpointStep", {
          day: state.day, step: track.stepLabel, name: applied.name
        }));
        this.scene.playPreset(applied.fx, state);
        this.ui.pushTicker(`${t(track.titleKey)} — ${applied.name}`);

        if (applied.mission) await this.handleMission(this.missionIdFor(applied.mission), token);
        if (applied.negotiation) {
          const ended = await this.handleNegotiation(token);
          if (ended || token !== this.runToken) return;
        }
        await this.ui.sleep(this.fast ? 90 : 650);
      }

      if (state.day === 1 && !state.flags.introMissionDone) {
        await this.handleMission("surface_swarm", token);
        this.update((current) => {
          current.flags.introMissionDone = true;
          current.flags.history.push("mission_surface_swarm");
        });
        if (token !== this.runToken) return;
      }

      this.update((current) => {
        current.phase = "DAY_IRAN";
        current.resume = this.resumePoint("iran", { policy, policyStep: 3 });
      });
      saveCheckpoint(t("director.checkpointUsDone", { day: state.day }));
      stage = "iran";
    }

    if (stage === "iran") {
      policy = policy || state.resume?.policy || this.policySnapshot({});
      const selectedEvent = chooseIranEvent(state, this.events, this.random);
      this.update((current) => {
        current.phase = "DAY_IRAN";
        current.resume = this.resumePoint("iran_response", {
          policy,
          eventId: selectedEvent.id
        });
      });
      saveCheckpoint(t("director.checkpointIran", {
        day: state.day, brief: pick(selectedEvent, "brief")
      }));
      stage = "iran_response";
    }

    if (stage === "iran_response") {
      policy = state.resume?.policy || policy || this.policySnapshot({});
      const event = this.eventById(state.resume?.eventId)
        || chooseIranEvent(state, this.events, this.random);
      this.scene.playPreset(event.fx, state);
      this.ui.setBrief(pick(event, "brief"));
      this.ui.pushTicker(pick(event, "brief"));
      await this.ui.showCinematicBriefing({
        eyebrow: t("director.iranEyebrow"),
        title: t("director.iranTitle", { name: policy.name }),
        text: pick(event, "brief"),
        detail: this.iranReactionDetail(policy, state, event),
        image: "assets/images/briefings/iran-response-council-v1.webp",
        tone: "hostile",
        action: t(event.mission || event.urgent
          ? "director.iranActionReview"
          : "director.iranActionReturn")
      });
      if (token !== this.runToken) return;
      if (event.mission || event.id === "swarm_approach") {
        const result = await this.handleMission(
          event.id === "swarm_approach" ? "surface_swarm" : this.missionIdFor(event.mission),
          token
        );
        this.update((current) => {
          current.flags.history.push(event.id);
          current.log.push(t("director.missionLog", {
            brief: pick(event, "brief"),
            outcome: t(result.success ? "common.success" : "common.failure")
          }));
        });
      } else if (event.urgent) {
        const choice = await this.ui.choose({
          kind: "urgent",
          title: pick(event, "brief"),
          subtitle: t("director.urgentSubtitle"),
          options: event.urgent.choices,
          timeout: this.fast ? 350 : 120000,
          autoIndex: event.urgent.auto ?? 0
        });
        if (token !== this.runToken || !choice) return;
        this.update((current) => {
          applyDelta(current, choice.delta);
          if (choice.flag) current.flags[choice.flag] = true;
          current.flags.history.push(event.id);
          current.log.push(`${pick(choice, "name")}: ${pick(choice, "desc")}`);
        });
        this.ui.pushTicker(t("director.orderExecuted", { name: pick(choice, "name") }));
        if (choice.mission) {
          const result = await this.handleMission(this.missionIdFor(choice.mission), token);
          this.update((current) => {
            current.log.push(t("director.rescueLog", {
              name: pick(choice, "name"),
              outcome: t(result.success ? "common.success" : "common.failure")
            }));
          });
        }
      }
      if (token !== this.runToken) return;
      this.update((current) => {
        current.phase = "DAY_IRAN";
        current.resume = this.resumePoint("president", { policy, policyStep: 3, eventId: "" });
      });
      saveCheckpoint(t("director.checkpointBothDone", { day: state.day }));
      stage = "president";
    }

    if (stage === "president") {
      const statement = this.statementForSlot(state.day, 1);
      if (statement) {
        const previous = state.day > 1 ? this.statementForSlot(state.day, 0) : null;
        const spoken = await this.deliverStatement(state.day, statement, token, previous);
        if (token !== this.runToken) return;
        if (spoken) this.ui.pushTicker(t("director.presidentTicker", { line: pick(spoken, "line") }));
      }
      this.update((current) => {
        current.phase = "DAY_RESOLVE";
        current.resume = this.resumePoint("resolve", { policy: null, policyStep: 0, eventId: "" });
      });
      saveCheckpoint(t("director.checkpointPresidentDone", { day: state.day }));
      stage = "resolve";
    }

    if (stage === "resolve") {
      this.update((current) => {
        current.phase = "DAY_RESOLVE";
        resolveDay(current);
        current.resume = this.resumePoint("report", { policy: null, policyStep: 0, eventId: "" });
      });
      saveCheckpoint(t("director.checkpointDayReport", { day: state.day }));
      stage = "report";
    }

    if (stage === "report") {
      this.ui.render(state);
      const terminal = checkTerminalEnding(state);
      if (terminal) {
        await this.end(terminal);
        return;
      }
      await this.ui.showDayReport(state, this.fast ? 180 : 1600);
      this.update((current) => {
        current.day = Math.min(MAX_CAMPAIGN_DAY, current.day + 1);
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
      saveCheckpoint(t("director.dayBrief", { day: state.day }));
    }
  }

  resumePoint(stage, patch = {}) {
    return {
      stage,
      day: this.state.day,
      replayIndex: this.state.replay.choices.length,
      policy: patch.policy === undefined ? this.state.resume?.policy || null : patch.policy,
      policyStep: patch.policyStep === undefined
        ? Math.max(0, Math.min(3, Number(this.state.resume?.policyStep) || 0))
        : Math.max(0, Math.min(3, Number(patch.policyStep) || 0)),
      eventId: patch.eventId === undefined ? this.state.resume?.eventId || "" : patch.eventId
    };
  }

  policySnapshot(policy) {
    return {
      id: String(policy?.id || "previous_policy").slice(0, 50),
      cat: String(policy?.cat || "MIL").slice(0, 20),
      name: String(pick(policy || {}, "name") || t("director.legacyPolicyName")).slice(0, 100),
      desc: String(pick(policy || {}, "desc") || t("director.legacyPolicyDesc")).slice(0, 240),
      delta: { ...(policy?.delta || {}) },
      flag: String(policy?.flag || "").slice(0, 50),
      mission: String(policy?.mission || "").slice(0, 50),
      negotiation: Boolean(policy?.negotiation),
      fx: String(policy?.fx || "").slice(0, 50)
    };
  }

  scaledPolicyDelta(policy) {
    const factor = policy.cat === "MIL" ? 0.55 : policy.cat === "DIP" ? 0.45 : 0.5;
    return Object.fromEntries(
      Object.entries(policy.delta || {}).map(([key, value]) => [key, Number(value) * factor])
    );
  }

  combineDailyPolicy(current, next) {
    const names = current?.name ? current.name.split(" · ") : [];
    if (next?.name && !names.includes(next.name)) names.push(next.name);
    const delta = { ...(current?.delta || {}) };
    for (const [key, value] of Object.entries(next?.delta || {})) {
      delta[key] = (Number(delta[key]) || 0) + (Number(value) || 0);
    }
    return {
      id: `daily_plan_${this.state.day}`,
      cat: "DAILY",
      name: names.join(" · ").slice(0, 100),
      desc: names.length
        ? t("director.combinedDesc", { names: names.join(", ") }).slice(0, 240)
        : t("director.combinedDescFallback"),
      delta,
      flag: "",
      mission: "",
      negotiation: false,
      fx: next?.fx || current?.fx || ""
    };
  }

  /**
   * 그날 나올 발언을 고른다.
   *
   * 세 진영(미국·이스라엘·이란)이 번갈아 나오게 한다. 한쪽 말만 며칠씩 이어지면
   * 전쟁이 한 편의 주장으로만 보인다. 그리고 전쟁 초반에는 초반에 나온 발언을
   * 먼저 쓴다 — 개전 첫날 발언이 종전 협상 발언보다 뒤에 나오면 앞뒤가 안 맞는다.
   */
  /**
   * 미국 차례에 쓸 선택 묶음. 전쟁 시기에 맞는 것부터 고르고, 한 번 쓴 묶음은
   * 다시 나오지 않게 돌려 쓴다.
   */
  /**
   * 발언을 화면에 내보낸다.
   *
   * 플레이어는 미국 대통령이다. 미국 차례에는 무슨 말을 할지 고르게 하고 그
   * 결과를 지표에 반영한다. 다른 나라 발언은 그대로 전달만 한다 — 남의 입을
   * 플레이어가 고르게 하면 그건 더 이상 그 나라의 말이 아니다.
   */
  async deliverStatement(day, statement, token, previous = null) {
    if ((statement.speaker || "us") === "us") {
      const set = this.presidentChoiceSetFor(day);
      if (set && (set.options || []).length) {
        const chosen = await this.ui.choosePresidentStatement({ day, set });
        if (token !== this.runToken) return null;
        if (chosen) {
          /* 고르는 것으로 끝내지 않는다. 고른 말을 실제로 하는 장면을 보여준다.
           * 말하는 것 자체가 이 게임에서 대통령이 하는 일이므로, 결과 수치만
           * 바뀌고 발언 장면이 없으면 무엇을 한 것인지 남지 않는다.
           * 발표 화면은 다른 나라 발언과 같은 틀을 쓰되 묶음(set)에서 직함과
           * 제목을 가져온다. 선택지 자체에는 그 정보가 없다. */
          await this.ui.showPresidentStatement({
            day,
            statement: {
              ...chosen,
              speaker: set.speaker || "us",
              speakerRoleKo: set.speakerRoleKo,
              speakerRoleEn: set.speakerRoleEn,
              headingKo: set.headingKo,
              headingEn: set.headingEn
            },
            previous,
            delivered: true
          });
          if (token !== this.runToken) return null;
          this.update((current) => {
            applyDelta(current, chosen.delta || {});
            current.log.push(t("director.presidentTicker", { line: pick(chosen, "line") }));
            current.log = current.log.slice(-120);
          });
          this.ui.render(this.state);
          return chosen;
        }
      }
    }
    await this.ui.showPresidentStatement({ day, statement, previous });
    if (token !== this.runToken) return null;
    return statement;
  }

  presidentChoiceSetFor(day) {
    if (!this.presidentChoiceSets.length) return null;
    const turn = Math.max(1, Number(day) || 1);
    /* 시기에 안 맞는 것만 뺀다. 시기로 딱 잘라 거르면 초반에 쓸 묶음이 하나뿐이라
       며칠 내내 같은 선택지가 반복된다. 협상 국면은 전쟁이 좀 지난 뒤에 연다. */
    const pool = this.presidentChoiceSets.filter(
      (set) => (set.phase || "mid") !== "late" || turn >= 10
    );
    const list = pool.length ? pool : this.presidentChoiceSets;
    return list[(turn - 1) % list.length] || null;
  }

  /** 하루에 두 번 말한다. slot 0 = 아침(브리핑 직후), slot 1 = 저녁(하루 정산 전). */
  statementForSlot(day, slot) {
    return this.presidentStatementForDay((Math.max(1, Number(day) || 1) - 1) * 2 + slot + 1);
  }

  presidentStatementForDay(day) {
    if (!this.presidentStatements.length) return null;
    const turn = Math.max(1, Number(day) || 1);
    /* 교전 당사국 셋 사이에 중재국을 끼워 넣는다. 싸우는 쪽 말만 이어지면
       전쟁이 두 편의 고함으로만 보인다. 중재국이 사이에 들어가야 판이 보인다. */
    const order = ["us", "israel", "iran", "pakistan", "us", "iran", "qatar", "israel", "oman"];
    const speaker = order[(turn - 1) % order.length];
    const phase = turn <= 6 ? "early" : (turn <= 24 ? "mid" : "late");

    const bySpeaker = this.presidentStatements.filter(
      (item) => (item.speaker || "us") === speaker
    );
    const pool = bySpeaker.length ? bySpeaker : this.presidentStatements;
    const staged = pool.filter((item) => (item.phase || "mid") === phase);
    const list = staged.length ? staged : pool;
    /* ★ 색인은 '몇 번째 날인가' 가 아니라 '이 진영이 몇 번째로 말하는가' 로 센다.
       순환 순서에 같은 진영이 두 번 들어 있어서(미국·이란), 날짜로 세면
       하루 걸러 같은 발언이 다시 나온다. */
    const position = (turn - 1) % order.length;
    const perCycle = order.filter((name) => name === speaker).length || 1;
    const before = order.slice(0, position).filter((name) => name === speaker).length;
    const nth = Math.floor((turn - 1) / order.length) * perCycle + before;
    return list[nth % list.length] || null;
  }

  eventById(id) {
    return Array.isArray(this.events)
      ? this.events.find((event) => event.id === id) || null
      : null;
  }

  missionIdFor(type) {
    return {
      intercept: "air_defense",
      minesweep: "mine_clearance",
      bombrun: "strategic_strike",
      pickaxe: "pickaxe_strike",
      bunker: "pickaxe_strike",
      nuclear: "pickaxe_strike",
      rescue: "tanker_rescue",
      tanker: "tanker_rescue",
      large: "large_fleet_battle",
      fleet: "large_fleet_battle",
      carrier: "large_fleet_battle"
    }[type] || "surface_swarm";
  }

  missionById(id) {
    return this.missionData?.missions?.find((mission) => mission.id === id)
      || this.missionData?.missions?.[0];
  }

  battleContextFor(mission) {
    const history = Array.isArray(this.state.campaign?.battleHistory)
      ? this.state.campaign.battleHistory
      : [];
    const scenario = mission.scenario || missionScenarioId(mission.mission || mission.id);
    const previous = history.filter((entry) => entry.id === scenario);
    const repeatCount = previous.length;
    const wins = previous.filter((entry) => entry.success).length;
    const losses = repeatCount - wins;
    let winStreak = 0;
    for (let index = history.length - 1; index >= 0 && history[index].success; index--) winStreak++;

    const day = Math.max(1, Number(this.state.day) || 1);
    let difficulty = day <= 4 ? 1 : day <= 8 ? 2 : day <= 12 ? 3 : day <= 18 ? 4 : 5;
    if (repeatCount >= 1 || winStreak >= 2 || this.state.dials.esc >= 4) difficulty++;
    if (repeatCount >= 3 || winStreak >= 4) difficulty++;
    if (previous.at(-1)?.success === false) difficulty--;
    difficulty = Math.max(1, Math.min(5, difficulty));

    const lastWinningForces = [...history].reverse().find((entry) => (
      entry.success && entry.forces && Object.values(entry.forces).some((value) => value > 0)
    ))?.forces || {};
    const counterType = Object.entries(lastWinningForces)
      .sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] || "";
    const scenarioHash = [...scenario].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const variant = Math.abs((Number(this.state.seed) || 0) + scenarioHash + repeatCount + day) % 3;

    return {
      day,
      act: this.state.act,
      stance: this.state.iran.stance,
      escalation: Math.round(this.state.dials.esc),
      stability: Math.round(this.state.iran.stability),
      missiles: Math.round(this.state.iran.missiles),
      repeatCount,
      wins,
      losses,
      winStreak,
      difficulty,
      variant,
      counterType,
      seed: Number(this.state.seed) || 0
    };
  }

  async handleMission(id, token) {
    const mission = this.missionById(id);
    const rtsScenario = mission.scenario || {
      surface_swarm: "convoy_shield",
      air_defense: "missile_screen",
      mine_clearance: "mine_corridor",
      tanker_rescue: "tanker_rescue",
      strategic_strike: "coastal_battery",
      pickaxe_strike: "pickaxe_mountain",
      large_fleet_battle: "large_fleet_battle"
    }[mission.id] || "convoy_shield";
    return this.handleRtsMission({ ...mission, combatMode: "rts", scenario: rtsScenario }, token);
  }

  async handleRtsMission(mission, token) {
    const politics = this.state.politics;
    const availableBudget = Math.max(0, politics.authorizedBudget - politics.spentBudget);
    const missionBudget = Math.min(mission.budgetCap || 480, availableBudget);
    const battleContext = this.battleContextFor(mission);
    this.update((state) => { state.phase = "MISSION"; });
    this.scene.playPreset("swarm", this.state);
    this.ui.setBrief(t("director.missionBrief", {
      title: pick(mission, "title"), budget: missionBudget
    }));
    const result = this.fast
      ? await this.ui.sleep(220).then(() => ({
          success: true,
          destroyed: mission.targetCount,
          budgetUsed: Math.min(mission.budgetRecommended || missionBudget, missionBudget),
          supplementalBudget: 0,
          politics: {
            congressSupport: politics.congressSupport,
            partySupport: politics.partySupport,
            approvalDelta: 0,
            intlDelta: 0,
            forcedAppropriation: false
          },
          difficulty: battleContext.difficulty,
          variant: battleContext.variant,
          targetCount: mission.targetCount,
          forces: {}
        }))
      : await this.ui.runRtsBattle(mission, {
          budget: missionBudget,
          congressSupport: politics.congressSupport,
          partySupport: politics.partySupport,
          approval: this.state.dials.approval,
          battleContext
        });
    if (token !== this.runToken || !result) {
      return { success: false, destroyed: 0, budgetUsed: 0 };
    }

    this.update((state) => {
      const politicalResult = result.politics || {};
      const supplemental = Math.max(0, Number(result.supplementalBudget) || 0);
      const budgetUsed = Math.max(0, Number(result.budgetUsed) || 0);
      state.politics.authorizedBudget += supplemental;
      state.politics.supplementalBudget += supplemental;
      state.politics.spentBudget += budgetUsed;
      if (Number.isFinite(Number(politicalResult.congressSupport))) {
        state.politics.congressSupport = Math.max(
          0,
          Math.min(100, Number(politicalResult.congressSupport))
        );
      }
      if (Number.isFinite(Number(politicalResult.partySupport))) {
        state.politics.partySupport = Math.max(
          0,
          Math.min(100, Number(politicalResult.partySupport))
        );
      }
      state.politics.appropriationsPassed += supplemental && !politicalResult.forcedAppropriation ? 1 : 0;
      state.politics.forcedAppropriations += politicalResult.forcedAppropriation ? 1 : 0;
      applyDelta(state, {
        ...(result.success ? mission.success : mission.failure),
        approval: (result.success ? mission.success?.approval || 0 : mission.failure?.approval || 0)
          + (Number(politicalResult.approvalDelta) || 0),
        intl: (result.success ? mission.success?.intl || 0 : mission.failure?.intl || 0)
          + (Number(politicalResult.intlDelta) || 0)
      });
      const list = result.success
        ? state.campaign.completedOperations
        : state.campaign.failedOperations;
      if (!list.includes(mission.scenario || mission.id)) list.push(mission.scenario || mission.id);
      state.campaign.lastBattle = {
        id: mission.scenario || mission.id,
        success: Boolean(result.success),
        budgetUsed,
        destroyed: Number(result.destroyed) || 0,
        day: battleContext.day,
        difficulty: battleContext.difficulty,
        variant: battleContext.variant,
        at: new Date().toISOString()
      };
      if (!Array.isArray(state.campaign.battleHistory)) state.campaign.battleHistory = [];
      state.campaign.battleHistory.push({
        id: mission.scenario || mission.id,
        success: Boolean(result.success),
        day: battleContext.day,
        difficulty: battleContext.difficulty,
        variant: battleContext.variant,
        forces: result.forces && typeof result.forces === "object" ? { ...result.forces } : {},
        at: new Date().toISOString()
      });
      state.campaign.battleHistory = state.campaign.battleHistory.slice(-60);
      state.flags.history.push(`mission_${mission.scenario || mission.id}`);
      const targetCount = Number(result.targetCount) || mission.targetCount;
      state.log.push(t("director.missionLogLine", {
        title: pick(mission, "title"),
        outcome: t(result.success ? "mission.objectiveMet" : "mission.objectiveMissed"),
        destroyed: Number(result.destroyed) || 0,
        target: targetCount,
        difficulty: battleContext.difficulty,
        budget: budgetUsed
      }));
    });
    await this.ui.showMissionResult(mission, result, this.fast ? 180 : 2400);
    this.ui.pushTicker(result.success
      ? t("director.missionTickerDone", {
          title: pick(mission, "title"), budget: Number(result.budgetUsed) || 0
        })
      : t("director.missionTickerFail", { title: pick(mission, "title") }));
    return result;
  }

  async handleNegotiation(token) {
    if (this.state.negotiation.tries <= 0) return false;
    if (this.state.day < MIN_SUCCESS_DAY) {
      await this.ui.showCinematicBriefing({
        eyebrow: t("director.negoEarlyEyebrow", { day: this.state.day }),
        title: t("director.negoEarlyTitle"),
        text: t("director.negoEarlyText", { day: MIN_SUCCESS_DAY }),
        detail: t("director.negoEarlyDetail"),
        image: "assets/images/briefings/oman-backchannel-v1.webp",
        tone: "ally",
        action: t("director.negoEarlyAction")
      });
      return false;
    }
    this.update((state) => {
      state.phase = "NEGOTIATION";
      state.negotiation.open = true;
      state.act = "EXIT";
    });
    const terms = await this.ui.negotiation(this.state, { fast: this.fast });
    if (token !== this.runToken || !terms) return false;
    const result = resolveNegotiation(this.state, terms);
    this.update((state) => {
      state.negotiation.terms = terms;
      if (!result.success) {
        state.negotiation.tries = Math.max(0, state.negotiation.tries - 1);
        applyDelta(state, { esc: 1, intl: result.near ? 1 : -3 });
        state.log.push(t("director.negoBrokeLog", {
          power: result.power, demand: result.demand
        }));
      }
    });
    this.ui.pushTicker(t(result.success ? "director.negoDoneTicker" : "director.negoFailTicker", {
      power: result.power, demand: result.demand
    }));
    if (!result.success) return false;
    const endingId = negotiatedEndingId(this.state, terms);
    if (!endingId) return false;
    await this.end(endingId);
    return true;
  }

  async end(endingId) {
    this.update((state) => { finalizeEnding(state, endingId, this.endings); });
    saveCheckpoint(t("director.checkpointEnd", {
      name: pick(this.state.ended || {}, "name") || endingId
    }));
    this.scene.playPreset("ending", this.state);
    this.endAction = await this.ui.showEnding(this.state);
  }

  dailyBrief(state) {
    const date = new Date(2026, 6, 27 + state.day);
    const dateText = `${date.getMonth() + 1}.${String(date.getDate()).padStart(2, "0")}`;
    const messages = {
      LULL: t("director.actBrief.LULL"),
      REIGNITE: t("director.actBrief.REIGNITE"),
      ATTRITION: t("director.actBrief.ATTRITION"),
      EXIT: t("director.actBrief.EXIT")
    };
    return `DAY ${state.day} · ${dateText} — ${messages[state.act]}`;
  }

  iranReactionDetail(policy, state, event) {
    const pressure = state.dials.esc >= 4
      ? t("director.iranPressureHigh")
      : t("director.iranPressureLow");
    const impact = policy.delta?.intl < 0
      ? t("director.iranImpactIntl")
      : policy.delta?.approval > 0
        ? t("director.iranImpactApproval")
        : t("director.iranImpactDefault");
    return t("director.iranSummary", {
      pressure, impact, brief: pick(event, "brief")
    });
  }

  actName(act) {
    return t(`director.actShort.${act}`);
  }
}
