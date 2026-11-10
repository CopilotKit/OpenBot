import {
  type BuiltInAgentClassicConfig,
  type BuiltInAgentConfiguration,
  resolveModel,
} from "@copilotkit/runtime/v2";
import { openParts } from "@openbot/shared/routine-checklist";
import {
  LAST_STEP_NOTICE,
  openPartsNudge,
  promiseNudge,
} from "@openbot/shared/run-notices";
import { unkeptPromise } from "./unkept-promise";

// Use the model contract of the runtime we actually ship, without a second AI SDK version.
type Model = Extract<
  BuiltInAgentClassicConfig["model"],
  { specificationVersion: "v3" }
>;
type CallOptions = Parameters<Model["doStream"]>[0];
type Prompt = CallOptions["prompt"];
type StreamResult = Awaited<ReturnType<Model["doStream"]>>;
type Part = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;
type GenerateResult = Awaited<ReturnType<Model["doGenerate"]>>;
type Usage = GenerateResult["usage"];

/**
 * One run's state, as the model wrapper keeps it between the steps of a run. One per agent, and so
 * one per run: the runtime clones the agent before every run, and the agent resets it when a run
 * starts (`startRun`).
 */
export type RunSteps = {
  /**
   * Where this run's steps start: how many model turns the conversation already held when its
   * first step was sent. Unset until then.
   */
  before?: number;
  /** Nudges sent since the run last called a tool. See {@link MOST_NUDGES}. */
  nudges?: number;
  /** The parts of the routine this run is a firing of. Empty: not a multi-part routine. */
  parts?: readonly string[];
  /** Everything the model has said in this run, which is what closes a part. */
  said?: string;
};

/** A new run's state: counted from where it starts, never from where an earlier run stopped. */
export function startRun(steps: RunSteps, parts: readonly string[] = []) {
  steps.before = undefined;
  steps.nudges = 0;
  steps.parts = parts;
  steps.said = "";
}

/**
 * How many times in a row a run is sent back to work before it is let go.
 *
 * Two, and counted again from nothing whenever the run calls a tool: the shape of Claude Code's Stop
 * hook cap (consecutive continuations, reset on a tool call). A model that ends on a promise twice
 * in a row after being told is not going to keep it on the third, and the run should end with what
 * it has rather than spend more.
 */
export const MOST_NUDGES = 2;

/**
 * The step budget of a run nobody is watching: a routine's firing, or a check-in.
 *
 * Interactive chat keeps its eight (`TOOL_STEPS` in the server's copilot.ts): a person is there to
 * say "carry on", and every extra step is their wait. A routine has nobody to say it. The routine
 * that showed this needed about twenty lookups, and seven tool-enabled steps made one twenty-call
 * burst the only plan that fitted.
 *
 * `base` covers that routine even read one lookup per step, with room to answer; a model reading a
 * few at a time, as it is asked to, uses well under half. Each part of a multi-part routine is its
 * own reads and its own write, so `perPart` more steps each. `most` is the ceiling the server sets
 * as the run's `maxSteps`: a model calling tools in a circle stops there, and the turn's own timeout
 * (`TURN_LIMITS.turnTimeoutMs`) still bounds the wall clock.
 */
export const UNATTENDED_STEPS = { base: 24, perPart: 4, most: 48 } as const;

/** The step an unattended run of this many parts answers on, under the ceiling it was given. */
export function unattendedLastStep(parts: number, maxSteps: number): number {
  return Math.min(
    maxSteps,
    UNATTENDED_STEPS.base + UNATTENDED_STEPS.perPart * parts,
  );
}

function turnsIn(prompt: Prompt): number {
  return prompt.filter((message) => message.role === "assistant").length;
}

/** A one-turn message: in this call's prompt only, never in the conversation. */
function told(prompt: Prompt, text: string): Prompt {
  return [...prompt, { role: "user", content: [{ type: "text", text }] }];
}

/**
 * A Bot's run that always ends by saying something, and does not end on a promise.
 *
 * THE LAST STEP. A run with tools stops after `maxSteps` model steps, and it stopped wherever it
 * was. A Bot that searched once per step spent all eight on searches, and the run ended on the
 * eighth search's results with no answer. So the last step a run is allowed is sent with no tool to
 * choose, and since a routine that ended "I'll fetch the rest now" on exactly that step, with a
 * message that says so: tools are off, answer from what you have, then say what you did not get to
 * and why ({@link LAST_STEP_NOTICE}). Every step before it is untouched.
 *
 * AN UNKEPT PROMISE. A step that ends the run (it called no tool and the model stopped) is held back
 * before the runtime sees it. If its words promise work it did not do ({@link unkeptPromise}), or a
 * routine's part is still open ({@link openParts}), the model is asked again in the same step with
 * the answer it gave and a one-turn nudge after it, and what it does then is streamed on as the
 * rest of that step: a tool call carries the run on as usual. At most {@link MOST_NUDGES} in a row,
 * counted again from nothing after any tool call, and never on the last step, where it has no tools
 * to keep a promise with. The nudge itself is never in the conversation: the next step's prompt holds
 * what the model said and did, not what it was told.
 *
 * WHICH STEP IS LAST IS READ FROM THE PROMPT, NOT COUNTED. The AI SDK retries a failed call with the
 * same prompt, so counting calls would take a step for every retry. Each step adds one assistant turn
 * to the prompt, so the step a call is for is how many the prompt holds past where the run began. A
 * nudged step is still one assistant turn, so a nudge never uses a step up.
 *
 * A wrapper around the model because the runtime takes only `maxSteps` and offers no hook between
 * steps, the same reason `withToolSearch` is one. A configuration with no step limit, or a model the
 * runtime cannot resolve here, is returned as it is.
 */
export function answersOnLastStep(
  configuration: BuiltInAgentConfiguration,
  steps: RunSteps,
  run: { unattended?: boolean } = {},
): BuiltInAgentConfiguration {
  if ("factory" in configuration) return configuration;
  const { maxSteps } = configuration;
  if (!maxSteps || maxSteps < 2 || !configuration.tools?.length)
    return configuration;
  let model: unknown;
  try {
    model = resolveModel(configuration.model, configuration.apiKey);
  } catch {
    return configuration;
  }
  if (!isModel(model)) return configuration;
  const inner = model;

  /** The call for this step, and whether it is the run's last. */
  const forStep = (options: CallOptions) => {
    const turns = turnsIn(options.prompt);
    steps.before ??= turns;
    const step = turns - steps.before + 1;
    const lastStep = run.unattended
      ? unattendedLastStep(steps.parts?.length ?? 0, maxSteps)
      : maxSteps;
    return step >= lastStep
      ? {
          last: true,
          call: {
            ...options,
            prompt: told(options.prompt, LAST_STEP_NOTICE),
            toolChoice: { type: "none" as const },
          },
        }
      : { last: false, call: options };
  };

  /**
   * The nudge an answer that would end the run has earned, or undefined when it may end. `text` is
   * already in `steps.said`, so a part this answer closes counts as closed.
   */
  const nudgeFor = (text: string): string | undefined => {
    if ((steps.nudges ?? 0) >= MOST_NUDGES) return undefined;
    const open = openParts(steps.parts ?? [], steps.said ?? "");
    const promise = unkeptPromise(text);
    const nudge = [
      ...(promise ? [promiseNudge(promise)] : []),
      ...(open.length > 0 ? [openPartsNudge(open)] : []),
    ].join(" ");
    if (!nudge) return undefined;
    steps.nudges = (steps.nudges ?? 0) + 1;
    return nudge;
  };

  /** The same call asked again, with what it answered and the nudge after it. */
  const again = (call: CallOptions, text: string, nudge: string) => ({
    ...call,
    prompt: told(
      [
        ...call.prompt,
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text }],
        },
      ],
      nudge,
    ),
  });

  const doStream = async (options: CallOptions): Promise<StreamResult> => {
    const { last, call } = forStep(options);
    const result = await inner.doStream(call);
    if (last) {
      return { ...result, stream: heard(result.stream) };
    }
    return { ...result, stream: heldToItsWord(result.stream, call) };
  };

  /** The last step's stream, as it is, with what it says kept for the run. */
  const heard = (stream: ReadableStream<Part>) =>
    stream.pipeThrough(
      new TransformStream<Part, Part>({
        transform(part, controller) {
          if (part.type === "text-delta")
            steps.said = `${steps.said ?? ""}${part.delta}`;
          controller.enqueue(part);
        },
      }),
    );

  /**
   * The step's stream, passed on as it arrives, with only its `finish` held until it is known whether
   * the step ends the run with work undone. If it does, the model is asked again and that ask's parts
   * follow on in the same stream, as they arrive, renamed so no text or reasoning id repeats within
   * the step. Its `stream-start` is dropped: a step starts once.
   */
  const heldToItsWord = (
    stream: ReadableStream<Part>,
    call: CallOptions,
  ): ReadableStream<Part> => {
    let reader = stream.getReader();
    let current = call;
    let asked = 0;
    let text = "";
    let called = false;
    let earlier: Usage | undefined;
    /**
     * Whether the person has already been shown words this step, which a second ask's first words
     * are set apart from by a paragraph break, so "I'll fetch the rest now." and what follows it do
     * not run together into one sentence.
     */
    let apart = false;
    const renamed = (part: Part): Part =>
      asked > 0 && "id" in part && isNamedPart(part.type)
        ? ({ ...part, id: `${part.id}-${asked}` } as Part)
        : part;
    return new ReadableStream<Part>({
      async pull(controller) {
        // Until something is passed on: a pull that enqueues nothing is not pulled again.
        for (;;) {
          const { done, value: part } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (part.type === "stream-start" && asked > 0) continue;
          if (part.type === "text-delta" && apart && part.delta) {
            apart = false;
            const delta = `

${part.delta.trimStart()}`;
            text += delta;
            controller.enqueue(renamed({ ...part, delta }));
            return;
          }
          if (part.type === "text-delta") text += part.delta;
          if (
            part.type === "tool-call" ||
            part.type === "tool-input-start" ||
            part.type === "tool-approval-request"
          )
            called = true;
          if (part.type !== "finish") {
            controller.enqueue(renamed(part));
            return;
          }
          const usage = earlier ? addUsage(earlier, part.usage) : part.usage;
          steps.said = `${steps.said ?? ""}\n${text}`;
          if (called) steps.nudges = 0;
          const nudge =
            !called && part.finishReason.unified === "stop"
              ? nudgeFor(text)
              : undefined;
          if (!nudge) {
            controller.enqueue({ ...part, usage });
            return;
          }
          const nextCall = again(current, text, nudge);
          let next: StreamResult;
          try {
            next = await inner.doStream(nextCall);
          } catch {
            // A nudge is a courtesy to the run; failing to send one must not fail the step it follows.
            controller.enqueue({ ...part, usage });
            return;
          }
          void reader.cancel().catch(() => {});
          reader = next.stream.getReader();
          current = nextCall;
          asked += 1;
          apart = text.trim().length > 0;
          text = "";
          earlier = usage;
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  };

  const doGenerate = async (options: CallOptions): Promise<GenerateResult> => {
    const { last, call } = forStep(options);
    let result = await inner.doGenerate(call);
    if (last) return result;
    let current = call;
    let seen = 0;
    for (;;) {
      const text = result.content
        .slice(seen)
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
      seen = result.content.length;
      steps.said = `${steps.said ?? ""}\n${text}`;
      const called = result.content.some(
        (part) =>
          part.type === "tool-call" || part.type === "tool-approval-request",
      );
      if (called) {
        steps.nudges = 0;
        return result;
      }
      if (result.finishReason.unified !== "stop") return result;
      const nudge = nudgeFor(text);
      if (!nudge) return result;
      current = again(current, text, nudge);
      let next: GenerateResult;
      try {
        next = await inner.doGenerate(current);
      } catch {
        return result;
      }
      result = {
        ...next,
        content: [...result.content, ...next.content],
        usage: addUsage(result.usage, next.usage),
      };
    }
  };

  const wrapped: Model = {
    specificationVersion: "v3",
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,
    doGenerate,
    doStream,
  };
  return { ...configuration, model: wrapped };
}

/** The parts whose `id` names a block of text or reasoning, which a second ask in one step reuses. */
function isNamedPart(type: string): boolean {
  return type.startsWith("text-") || type.startsWith("reasoning-");
}

function add(a: number | undefined, b: number | undefined) {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

/** Two asks in one step are billed as one: what the step cost is what both of them cost. */
function addUsage(a: Usage, b: Usage): Usage {
  return {
    ...b,
    inputTokens: {
      total: add(a.inputTokens.total, b.inputTokens.total),
      noCache: add(a.inputTokens.noCache, b.inputTokens.noCache),
      cacheRead: add(a.inputTokens.cacheRead, b.inputTokens.cacheRead),
      cacheWrite: add(a.inputTokens.cacheWrite, b.inputTokens.cacheWrite),
    },
    outputTokens: {
      total: add(a.outputTokens.total, b.outputTokens.total),
      text: add(a.outputTokens.text, b.outputTokens.text),
      reasoning: add(a.outputTokens.reasoning, b.outputTokens.reasoning),
    },
  };
}

function isModel(model: unknown): model is Model {
  return (
    typeof model === "object" &&
    model !== null &&
    (model as { specificationVersion?: unknown }).specificationVersion === "v3"
  );
}
