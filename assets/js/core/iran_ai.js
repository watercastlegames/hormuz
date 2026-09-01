import { pick } from "./rng.js";
import { missionScenarioId, recentBattleScenarioIds } from "./policy.js";

function eventBattleScenarios(event) {
  const scenarios = [];
  if (event?.id === "swarm_approach") scenarios.push("convoy_shield");
  if (event?.mission) scenarios.push(missionScenarioId(event.mission));
  for (const choice of event?.urgent?.choices || []) {
    if (choice.mission) scenarios.push(missionScenarioId(choice.mission));
  }
  return [...new Set(scenarios.filter(Boolean))];
}

export function chooseIranEvent(state, events, random) {
  const recent = new Set((state.flags.history || []).slice(-4));
  const recentScenarios = new Set(recentBattleScenarioIds(state, 2));
  const stancePool = events.filter((event) => (
    event.stance.includes(state.iran.stance) && !recent.has(event.id)
  ));
  let pool = stancePool.filter((event) => (
    !eventBattleScenarios(event).some((scenario) => recentScenarios.has(scenario))
  ));
  if (!pool.length) pool = stancePool;
  if (!pool.length) pool = events.filter((event) => event.stance.includes(state.iran.stance));
  if (!pool.length) pool = events;
  if (state.day >= 10 && state.iran.stance === "PRAGMATIC") {
    const offer = pool.find((event) => event.id === "ceasefire_offer");
    if (offer && random() < 0.55) return offer;
  }
  return pick(random, pool);
}
