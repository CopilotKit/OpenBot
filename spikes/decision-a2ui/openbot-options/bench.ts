import { readFileSync } from "node:fs";
import type { Decisions } from "@google/genai";
import { decisionModel } from "../decision.ts";
import {
  configuredKey,
  decisionClient,
  errorSummary,
  geminiClient,
} from "../live.ts";
import { cases } from "./cases.ts";

type Catalog = {
  id: string;
  version: string;
  functions: number;
  components: Record<string, string>;
};
const catalogs: { openbot: Catalog; standard: Catalog } = JSON.parse(
  readFileSync(new URL("./catalog-options.json", import.meta.url), "utf8"),
);
const openbot = catalogs.openbot.components;
const standard = catalogs.standard.components;
const arms = [
  "shortlist-6",
  "openbot-66",
  "standard-69",
  "openbot-67-scope",
  "openbot-67-shared",
] as const;
type Arm = (typeof arms)[number];
const noMatch = "no_match";
const minConfidence = 0.7;
const sharedCatalog = {
  ...openbot,
  [noMatch]:
    "No offered component can perform the essential interaction or display described in the request.",
};
const compactCriteria = Object.fromEntries(
  Object.keys(sharedCatalog).map((name) => [name, ""]),
);

function criteriaFor(arm: Arm, example: (typeof cases)[number]) {
  if (arm === "shortlist-6")
    return Object.fromEntries(
      example.shortlist.map((name) => [name, openbot[name]]),
    );
  if (arm === "standard-69") return standard;
  if (arm === "openbot-67-scope") return sharedCatalog;
  if (arm === "openbot-67-shared") return compactCriteria;
  return openbot;
}

function expectedFor(arm: Arm, example: (typeof cases)[number]) {
  if (arm === "standard-69")
    return example.standardExpected ?? example.expected;
  if (
    (arm === "openbot-67-scope" || arm === "openbot-67-shared") &&
    !example.expected.length
  )
    return [noMatch];
  return example.expected;
}

function questionsFor(arm: Arm) {
  return Object.fromEntries(
    cases.map((example) => [
      example.id,
      {
        type: "choice",
        instructions:
          arm === "openbot-67-shared"
            ? `Pick the single catalog component that best implements the requested slot. Look up each option's description in the shared input. Request: ${example.request}`
            : `Pick the single catalog component that best implements the requested slot. Use the option descriptions to check essential behavior. Request: ${example.request}`,
        criteria: criteriaFor(arm, example),
      } satisfies Decisions.ChoiceQuestion,
    ]),
  );
}

function checkFixtures() {
  const sizes = [6, 66, 69, 67, 67];
  if (new Set(cases.map((example) => example.id)).size !== cases.length)
    throw new Error("Duplicate case IDs");
  for (const [index, arm] of arms.entries()) {
    for (const example of cases) {
      const criteria = criteriaFor(arm, example);
      if (
        Object.keys(criteria).length !== sizes[index] ||
        Object.values(criteria).some(
          (description) =>
            typeof description !== "string" ||
            (arm !== "openbot-67-shared" && !description),
        ) ||
        expectedFor(arm, example).some((name) => !Object.hasOwn(criteria, name))
      ) {
        throw new Error(`Invalid fixture: ${arm}/${example.id}`);
      }
    }
  }
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));
async function evaluate(
  arm: Arm,
  run: number,
  submit: ReturnType<typeof decisionClient>,
) {
  const questions = questionsFor(arm);
  const started = performance.now();
  const descriptionInput =
    "These are independent synthetic UI requests. For each question select the best component for its requested slot using the catalog descriptions supplied as criteria.";
  const result = await submit({
    model: decisionModel,
    input:
      arm === "openbot-67-shared"
        ? `These are independent synthetic UI requests. Each question's option keys refer to this shared catalog of descriptions: ${JSON.stringify(sharedCatalog)}`
        : descriptionInput,
    questions,
  });
  const apiMs = round(performance.now() - started, 1);
  const answers = cases.map((example) => {
    const answer = result.answers?.[example.id];
    const criteria = questions[example.id].criteria;
    if (
      answer?.type !== "choice" ||
      !Object.hasOwn(criteria, answer.choice) ||
      !Number.isFinite(answer.confidence) ||
      answer.confidence < 0 ||
      answer.confidence > 1 ||
      !answer.probabilities ||
      Object.keys(answer.probabilities).length !==
        Object.keys(criteria).length ||
      !Object.keys(criteria).every(
        (name) =>
          Object.hasOwn(answer.probabilities, name) &&
          Number.isFinite(answer.probabilities[name]) &&
          answer.probabilities[name] >= 0 &&
          answer.probabilities[name] <= answer.confidence + 0.0001,
      ) ||
      Math.abs(answer.probabilities[answer.choice] - answer.confidence) > 0.0001
    ) {
      throw new Error(`Invalid typed answer: ${arm}/${example.id}`);
    }
    const expected = expectedFor(arm, example);
    return {
      id: example.id,
      pick: answer.choice,
      confidence: round(answer.confidence, 6),
      atThreshold: answer.confidence >= minConfidence,
      expected,
      correct: expected.length ? expected.includes(answer.choice) : null,
      next: Object.entries(answer.probabilities)
        .filter(([name]) => name !== answer.choice)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 2)
        .map(([name, probability]) => [name, round(probability, 6)]),
    };
  });
  console.log(
    JSON.stringify({
      arm,
      run,
      model: decisionModel,
      optionCount: Object.keys(questions[cases[0].id].criteria).length,
      apiMs,
      questionCount: cases.length,
      minConfidence,
      usage: result.usage,
      answers,
    }),
  );
}

const args = process.argv.slice(2);
checkFixtures();
if (args.length === 1 && args[0] === "--check") {
  console.log(
    `${cases.length} cases have usable descriptions and expected options across all ${arms.length} arms.`,
  );
} else {
  const selectedArms = args.includes("--shared-only")
    ? ["openbot-67-shared" as const]
    : arms.slice(0, 4);
  const repeats = args.filter((arg) => arg !== "--shared-only");
  const runs = Number(
    repeats[0]?.match(/^--runs=([1-3])$/)?.[1] ?? (repeats.length ? NaN : 3),
  );
  const key = configuredKey();
  if (repeats.length > 1 || !Number.isInteger(runs) || !key) {
    console.error(
      "Use node openbot-options/bench.ts [--runs=1|2|3] [--shared-only] with GEMINI_API_KEY or GOOGLE_API_KEY, or use --check offline.",
    );
    process.exitCode = 2;
  } else {
    const submit = decisionClient(geminiClient(key));
    for (let run = 1; run <= runs; run++) {
      const offset = (run - 1) % selectedArms.length;
      for (const arm of [
        ...selectedArms.slice(offset),
        ...selectedArms.slice(0, offset),
      ]) {
        try {
          await evaluate(arm, run, submit);
        } catch (error) {
          console.error(JSON.stringify({ arm, run, ...errorSummary(error) }));
          process.exitCode = 1;
        }
      }
    }
  }
}
