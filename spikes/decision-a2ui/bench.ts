import { chromium, type Browser, type Page } from "playwright-core";
import type { RendererState } from "@a2ui/agent";
import {
  MessageProcessor,
  type AgentToRendererMessage,
} from "@a2ui/web_core/v1_0";
import { DecisionSession, decisionModel } from "./decision.ts";
import { demoServer } from "./demo.ts";
import { actionFor, application, cases, type Example } from "./fixtures.ts";
import {
  configuredKey,
  decisionClient,
  errorSummary,
  expressModel,
  geminiClient,
  liveExpress,
} from "./live.ts";
import { createProcessor, spikeCatalog, surfaceId } from "./sdk.ts";

const round = (n: number | null | undefined) =>
  n == null ? null : Math.round(n * 10) / 10;
const catalog = spikeCatalog();
const processor = createProcessor(catalog);
const liveCases = cases.filter(
  (example) =>
    example.components || ["ambiguous", "unsupported"].includes(example.id),
);
const app = application;
type Mode = "decision" | "express";

function expectedComponents(example: Example, state: RendererState) {
  const components = state.getSurface(surfaceId)?.componentsModel;
  return Object.entries(example.components ?? {})
    .filter(([id, type]) => components?.get(id)?.type !== type)
    .map(([id, type]) => ({
      id,
      expected: type,
      actual: components?.get(id)?.type ?? null,
    }));
}

function hasComponentType(state: RendererState, type: string) {
  return [...(state.getSurface(surfaceId)?.componentsModel.entries ?? [])].some(
    ([, node]) => node.type === type,
  );
}

async function browserCheck(page: Page, example: Example, follow = false) {
  const surface = page.locator("a2ui-surface");
  if (follow) {
    await surface
      .getByText(app.results.items[1].summary, { exact: true })
      .waitFor({ timeout: 1000 });
  } else if (example.id.startsWith("settings")) {
    const name = surface.getByRole("textbox");
    await name.waitFor({ timeout: 1000 });
    return (
      (await name.inputValue()) === app.settings.name &&
      (await surface.getByRole("checkbox").isChecked({ timeout: 1000 })) ===
        app.settings.notify
    );
  } else if (example.id.startsWith("results")) {
    for (const item of app.results.items) {
      await surface
        .getByRole("button", { name: item.title, exact: true })
        .waitFor({ timeout: 1000 });
    }
  } else {
    await surface
      .getByRole("button", { name: app.confirmation.label })
      .waitFor({ timeout: 1000 });
    await surface
      .getByText(app.confirmation.detail, { exact: true })
      .waitFor({ timeout: 1000 });
  }
  return true;
}

async function runBench(
  apiKey: string,
  runs: number,
  browserRequested: boolean,
) {
  const client = geminiClient(apiKey);
  let server: Awaited<ReturnType<typeof demoServer>> | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    if (browserRequested) {
      server = await demoServer();
      browser = await chromium.launch(
        process.env.CHROME_PATH
          ? { executablePath: process.env.CHROME_PATH }
          : { channel: "chrome" },
      );
      page = await browser.newPage();
      await page.goto(server.url);
      await page.waitForFunction(() => typeof window.replayA2ui === "function");
    }
    for (let run = 1; run <= runs; run++) {
      const modes: Mode[] =
        run % 2 ? ["decision", "express"] : ["express", "decision"];
      for (const [index, example] of liveCases.entries()) {
        for (const mode of modes) {
          await scenario(
            mode,
            example,
            run,
            index === 0 ? (run === 1 ? "first-per-model" : "repeat") : "later",
            page,
          );
        }
      }
    }
  } finally {
    await browser?.close();
    await server?.close();
  }

  async function scenario(
    mode: Mode,
    example: Example,
    run: number,
    runOrder: string,
    page?: Page,
  ) {
    const renderer = new MessageProcessor([catalog]);
    const submit = decisionClient(client);
    const choices: Record<string, { choice: string; confidence: number }> = {};
    const decision = new DecisionSession(processor, async (request) => {
      const response = await submit(request);
      for (const [id, answer] of Object.entries(response.answers ?? {})) {
        const question = request.questions[id];
        if (
          question?.type === "choice" &&
          answer.type === "choice" &&
          Object.hasOwn(question.criteria, answer.choice)
        ) {
          choices[id] = {
            choice: answer.choice,
            confidence: answer.confidence,
          };
        }
      }
      return response;
    });
    const state =
      mode === "decision" ? decision.state : processor.createState();
    const model = mode === "decision" ? decisionModel : expressModel;
    let phase = "initial";
    const base = () => ({
      run,
      runOrder,
      case: example.id,
      model,
      phase,
      inferenceCalls: 1,
      repairs: 0,
      fallbacks: 0,
      ...(mode === "decision" ? { choices } : {}),
    });
    let stage = "generation";
    let callStarted = performance.now();
    try {
      const initial = {
        request: example.request,
        app,
        catalogId: catalog.id,
        currentState: null,
        interactionHistory: [],
      };
      const initialResult =
        mode === "decision"
          ? await timedDecision(() => decision.show(example.request, app))
          : await timedExpress(initial);
      await inspect(initialResult, true);
      if (example.id !== "results-nested" || !hasComponentType(state, "Button"))
        return;

      phase = "follow-up";
      for (const name of Object.keys(choices)) delete choices[name];
      stage = "action";
      let action = actionFor("birch");
      if (page) {
        await page
          .locator("a2ui-surface")
          .getByRole("button", { name: "Birch", exact: true })
          .click({ timeout: 1000 });
        const emitted = await page.evaluate(() => window.lastA2uiAction);
        if (!emitted) throw new Error("Renderer did not emit an action");
        action = emitted;
      }
      stage = "generation";
      callStarted = performance.now();
      const followInput = {
        request: example.request,
        family: "results",
        selectedItem: app.results.items[1],
        action: {
          name: action.action.name,
          sourceComponentId: action.action.sourceComponentId,
        },
        currentState: {
          surfaceId,
          detail: state.getSurface(surfaceId)?.dataModel.get("/detail"),
          selectedId: state.getSurface(surfaceId)?.dataModel.get("/selectedId"),
        },
        interactionHistory: [],
      };
      const follow =
        mode === "decision"
          ? await timedDecision(() => decision.follow(action))
          : await timedExpress(followInput);
      await inspect(follow, false);
    } catch (error) {
      const detail = errorSummary(error);
      const expectedRefusal =
        (example.id === "ambiguous" &&
          ["scope", "confidence"].includes(detail.kind)) ||
        (example.id === "unsupported" && detail.kind === "scope");
      const validationError = /Validation|Compilation|Integrity|Parse/.test(
        detail.kind,
      );
      console.log(
        JSON.stringify({
          ...base(),
          inferenceCalls: stage === "action" ? 0 : 1,
          stage,
          ...detail,
          sdkValidation: validationError ? "failed" : "no-complete-payload",
          successful: expectedRefusal,
          elapsedMs: round(performance.now() - callStarted),
        }),
      );
    } finally {
      renderer.dispose();
    }

    async function timedDecision(
      runTurn: () => ReturnType<DecisionSession["show"]>,
    ) {
      const started = performance.now();
      const result = await runTurn();
      const completeMs = performance.now() - started;
      const inputTokens = result.usage?.total_input_tokens;
      return {
        messages: result.messages,
        replyText: false,
        timing: {
          apiMs: round(result.apiMs),
          firstSdkRenderableMs: round(completeMs),
          sdkCompleteMs: round(completeMs),
        },
        usage: {
          inputTokens,
          outputTokens: result.usage?.total_output_tokens,
          estimatedPaidUsd:
            inputTokens === undefined
              ? undefined
              : (inputTokens * 0.1) / 1_000_000,
        },
      };
    }

    async function timedExpress(input: object) {
      const result = await liveExpress(client, processor, state, input);
      const inputTokens = result.usage?.promptTokenCount;
      const outputTokens = result.usage?.candidatesTokenCount;
      const thinkingTokens = result.usage?.thoughtsTokenCount ?? 0;
      const cachedTokens = result.usage?.cachedContentTokenCount ?? 0;
      return {
        messages: result.messages,
        replyText: Boolean(result.text.trim()),
        timing: {
          firstApiChunkMs: round(result.firstApiChunkMs),
          apiMs: round(result.lastApiChunkMs),
          firstSdkRenderableMs: round(result.firstRenderableMs),
          sdkCompleteMs: round(result.completeMs),
        },
        usage: {
          inputTokens,
          outputTokens,
          thinkingTokens,
          cachedTokens,
          modelVersion: result.modelVersion,
          estimatedPaidUsd:
            inputTokens === undefined || outputTokens === undefined
              ? undefined
              : ((inputTokens - cachedTokens) * 0.3 +
                  cachedTokens * 0.03 +
                  (outputTokens + thinkingTokens) * 2.5) /
                1_000_000,
        },
      };
    }

    async function inspect(
      result: {
        messages: AgentToRendererMessage[];
        replyText: boolean;
        timing: object;
        usage: object;
      },
      initial: boolean,
    ) {
      stage = "renderer";
      const { messages, timing, usage } = result;
      renderer.processMessages(messages);
      const mismatches = initial ? expectedComponents(example, state) : [];
      let chromeMeetsAssertion: boolean | null = null;
      let browserAccepted: boolean | null = null;
      let browserReplayMs: number | null = null;
      if (page && messages.length) {
        const replayStarted = performance.now();
        try {
          await page.evaluate(
            ({ messages, initial }) => window.replayA2ui(messages, initial),
            { messages, initial },
          );
          browserAccepted = true;
          if (example.components)
            chromeMeetsAssertion = await browserCheck(page, example, !initial);
        } catch {
          if (browserAccepted === null) browserAccepted = false;
          chromeMeetsAssertion = false;
        }
        browserReplayMs = round(performance.now() - replayStarted);
      }
      const noUi =
        messages.length === 0 || state.getSurface(surfaceId) === undefined;
      const expectedRefusal = Boolean(
        example.error && noUi && result.replyText,
      );
      const storedComponents = state.getSurface(surfaceId)?.componentsModel;
      const confirms =
        example.id !== "confirmation" ||
        storedComponents?.get("confirm")?.properties.variant === "primary";
      const plain =
        example.id !== "results-plain" ||
        !storedComponents?.has("detail_frame");
      const semanticMatch = initial
        ? Boolean(
            example.components && mismatches.length === 0 && confirms && plain,
          )
        : state.getSurface(surfaceId)?.dataModel.get("/detail") ===
            app.results.items[1].summary &&
          state.getSurface(surfaceId)?.dataModel.get("/selectedId") ===
            app.results.items[1].id;
      const successful =
        expectedRefusal || (semanticMatch && chromeMeetsAssertion !== false);
      console.log(
        JSON.stringify({
          ...base(),
          sdkValidation: messages.length ? "passed" : "no-payload",
          messages: messages.length,
          successful,
          mismatches,
          browserAccepted,
          chromeMeetsAssertion,
          browserReplayMs,
          ...timing,
          ...usage,
        }),
      );
    }
  }
}

const runs = Number(
  process.argv.find((arg) => arg.startsWith("--runs="))?.split("=")[1] ?? "2",
);
const validArgs = process.argv
  .slice(2)
  .every((arg) => arg === "--browser" || /^--runs=[1-3]$/.test(arg));
const key = configuredKey();
if (!validArgs || !Number.isInteger(runs) || runs < 1 || runs > 3) {
  console.error("Usage: npm run bench -- [--runs=1|2|3] [--browser]");
  process.exitCode = 2;
} else if (!key) {
  console.error(
    "No GEMINI_API_KEY or GOOGLE_API_KEY is configured. No API request was made.",
  );
  process.exitCode = 2;
} else {
  try {
    await runBench(key, runs, process.argv.includes("--browser"));
  } catch (error) {
    console.error(JSON.stringify(errorSummary(error)));
    process.exitCode = 1;
  }
}
