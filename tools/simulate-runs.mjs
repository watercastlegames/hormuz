import { mkdir, readFile, writeFile } from "node:fs/promises";
import { freshState } from "../assets/js/core/state.js";
import { mulberry32 } from "../assets/js/core/rng.js";
import { DAILY_DECISION_TRACKS, curatePolicyTrack } from "../assets/js/core/policy.js";
import { chooseIranEvent } from "../assets/js/core/iran_ai.js";
import {
  applyDelta, checkTerminalEnding, finalizeEnding, MAX_CAMPAIGN_DAY,
  MIN_SUCCESS_DAY, negotiatedEndingId, resolveDay, resolveNegotiation
} from "../assets/js/core/rules.js";

const readJson = async (name) => JSON.parse(await readFile(new URL(`../assets/data/${name}.json`, import.meta.url), "utf8"));
const [cards, events, endings] = await Promise.all([
  readJson("cards"), readJson("events"), readJson("endings")
]);

function play(seed) {
  const state = freshState(seed);
  const random = mulberry32(seed);
  state.day = 1;
  state.phase = "DAY_BRIEF";

  while (!state.ended) {
    for (const track of DAILY_DECISION_TRACKS) {
      const options = curatePolicyTrack(state, cards, random, track);
      const policy = options[Math.floor(random() * options.length)] || options[0];
      const factor = policy.cat === "MIL" ? 0.55 : policy.cat === "DIP" ? 0.45 : 0.5;
      applyDelta(state, Object.fromEntries(
        Object.entries(policy.delta || {}).map(([key, value]) => [key, Number(value) * factor])
      ));
      if (policy.flag) state.flags[policy.flag] = true;
      state.flags.history.push(policy.id);

      if (policy.negotiation && state.day >= MIN_SUCCESS_DAY && state.negotiation.tries > 0) {
        state.negotiation.open = true;
        state.act = "EXIT";
        const terms = Array.from({ length: 4 }, () => random() < 0.66 ? 0 : 1);
        const result = resolveNegotiation(state, terms);
        if (result.success) {
          const endingId = negotiatedEndingId(state, terms);
          if (endingId) finalizeEnding(state, endingId, endings);
          break;
        }
        state.negotiation.tries--;
        applyDelta(state, { esc: 1, intl: result.near ? 1 : -3 });
      }
    }
    if (state.ended) break;

    const event = chooseIranEvent(state, events, random);
    if (event.minigame) {
      applyDelta(state, random() < 0.76 ? event.success : event.failure);
    } else if (event.urgent) {
      const choice = event.urgent.choices[Math.floor(random() * event.urgent.choices.length)];
      applyDelta(state, choice.delta);
      if (choice.flag) state.flags[choice.flag] = true;
    }
    state.flags.history.push(event.id);

    resolveDay(state);
    const terminal = checkTerminalEnding(state);
    if (terminal) {
      finalizeEnding(state, terminal, endings);
      break;
    }
    state.day = Math.min(MAX_CAMPAIGN_DAY, state.day + 1);
  }
  return state.ended;
}

const runs = Array.from({ length: 100 }, (_, index) => play((0x484f524d + index * 7919) >>> 0));
const endingsCount = {};
const gradesCount = {};
for (const result of runs) {
  endingsCount[result.endingId] = (endingsCount[result.endingId] || 0) + 1;
  gradesCount[result.grade] = (gradesCount[result.grade] || 0) + 1;
}
const scores = runs.map((result) => result.score);
const days = runs.map((result) => result.endDay);
const report = {
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
    successfulEndingsRespectMinimumDay: runs.every((result) =>
      !["calm_hold", "short_war", "hormuz_accord", "uneasy_truce"].includes(result.endingId)
      || result.endDay >= MIN_SUCCESS_DAY
    )
  }
};

console.log(JSON.stringify(report, null, 2));
const outputDirectory = new URL("../output/validation/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });
await writeFile(new URL("simulation-100-runs.json", outputDirectory), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (!Object.values(report.invariants).every(Boolean)) process.exitCode = 1;
