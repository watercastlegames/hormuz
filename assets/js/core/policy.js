import { shuffle } from "./rng.js";

const MISSION_SCENARIOS = Object.freeze({
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

export function missionScenarioId(mission) {
  return MISSION_SCENARIOS[mission] || (mission ? "convoy_shield" : "");
}

export function recentBattleScenarioIds(state, limit = 2) {
  const history = Array.isArray(state?.campaign?.battleHistory)
    ? state.campaign.battleHistory
    : [];
  const ids = history.slice(-limit).map((entry) => entry?.id).filter(Boolean);
  const fallback = state?.campaign?.lastBattle?.id;
  if (!ids.length && fallback && !String(fallback).startsWith("history_")) ids.push(fallback);
  return ids;
}

export const DAILY_DECISION_TRACKS = [
  {
    id: "military",
    cats: ["MIL"],
    titleKey: "track.military.title",
    subtitleKey: "track.military.subtitle",
    stepLabel: "1/3"
  },
  {
    id: "diplomacy",
    cats: ["DIP"],
    titleKey: "track.diplomacy.title",
    subtitleKey: "track.diplomacy.subtitle",
    stepLabel: "2/3"
  },
  {
    id: "economy_info",
    cats: ["ECO", "INFO"],
    titleKey: "track.economy_info.title",
    subtitleKey: "track.economy_info.subtitle",
    stepLabel: "3/3"
  }
];

function unlocked(card, state) {
  if (card.unlock?.dayMin && state.day < card.unlock.dayMin) return false;
  if (card.unlock?.act && !card.unlock.act.includes(state.act)) return false;
  return true;
}

export function curatePolicies(state, cards, random) {
  const available = cards.filter((card) => unlocked(card, state));
  const recent = new Set((state.flags.history || []).slice(-8));
  const preferred = available.filter((card) => !recent.has(card.id));
  const source = preferred.length >= 3 ? preferred : available;
  const choices = [];

  const openChannel = source.find((card) => card.id === "open_channel");
  if (openChannel && (state.day === 4 || state.day === 7 || state.day >= 11)) choices.push(openChannel);

  const largeBattle = source.find((card) => card.id === "full_strait_battle");
  if (largeBattle && state.day >= 11 && state.act === "ATTRITION") choices.push(largeBattle);

  if (state.dials.transit < 48) {
    const transitCard = source
      .filter((card) => (card.delta?.transit || 0) > 6 && !choices.includes(card))
      .sort((a, b) => (b.delta.transit || 0) - (a.delta.transit || 0))[0];
    if (transitCard) choices.push(transitCard);
  }

  for (const card of shuffle(random, source)) {
    if (!choices.includes(card)) choices.push(card);
    if (choices.length === 3) break;
  }
  return choices.slice(0, 3);
}

export function curatePolicyTrack(state, cards, random, track) {
  const categories = new Set(track?.cats || []);
  const unlockedCards = cards.filter((card) => categories.has(card.cat) && unlocked(card, state));
  const recentScenarios = new Set(recentBattleScenarioIds(state, 2));
  const variedCards = unlockedCards.filter((card) => (
    !card.mission || !recentScenarios.has(missionScenarioId(card.mission))
  ));
  const available = variedCards.length >= 3 ? variedCards : unlockedCards;
  const recent = new Set((state.flags.history || []).slice(-18));
  const preferred = available.filter((card) => !recent.has(card.id));
  const source = preferred.length >= 3 ? preferred : available;
  const choices = [];

  if (track?.id === "diplomacy") {
    const openChannel = source.find((card) => card.id === "open_channel");
    if (openChannel && state.day >= 12) choices.push(openChannel);
  }

  if (track?.id === "military") {
    const largeBattle = source.find((card) => card.id === "full_strait_battle");
    if (largeBattle && state.day >= 11 && state.act === "ATTRITION") choices.push(largeBattle);

    if (state.dials.transit < 48) {
      const transitCard = source
        .filter((card) => (card.delta?.transit || 0) > 6 && !choices.includes(card))
        .sort((a, b) => (b.delta.transit || 0) - (a.delta.transit || 0))[0];
      if (transitCard) choices.push(transitCard);
    }
  }

  for (const card of shuffle(random, source)) {
    if (!choices.includes(card)) choices.push(card);
    if (choices.length === 3) break;
  }
  return choices.slice(0, 3);
}
