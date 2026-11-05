import {
  type BuiltInAgentClassicConfig,
  type BuiltInAgentConfiguration,
  resolveModel,
} from "@copilotkit/runtime/v2";

// Use the model contract of the runtime we actually ship, without a second AI SDK version.
type Model = Extract<
  BuiltInAgentClassicConfig["model"],
  { specificationVersion: "v3" }
>;
type CallOptions = Parameters<Model["doStream"]>[0];
type Prompt = CallOptions["prompt"];

/**
 * Where one run's steps start: how many model turns the conversation already held when its first
 * step was sent. Unset until then. One per agent, and so one per run: the runtime clones the agent
 * before every run, and the agent clears it when a run starts.
 */
export type RunSteps = { before?: number };

function turnsIn(prompt: Prompt): number {
  return prompt.filter((message) => message.role === "assistant").length;
}

/**
 * A Bot's run that always ends by saying something.
 *
 * A run with tools stops after `maxSteps` model steps, and it stopped wherever it was. A Bot that
 * searched once per step spent all eight on searches, and the run ended on the eighth search's
 * results with no answer: the person saw a subtask that "did not finish: the turn finished without
 * saying anything", and then its Bot did the same at its own ten. The searches were done and
 * thrown away.
 *
 * So the last step a run is allowed is sent with no tool to choose. The model has everything the
 * earlier steps found and has to answer from it, the way PROVENANCE_GUIDANCE asks: saying what it
 * checked and what it could not. Every step before it is untouched.
 *
 * WHICH STEP IS LAST IS READ FROM THE PROMPT, NOT COUNTED. The AI SDK retries a failed call with the
 * same prompt, so counting calls would take a step for every retry. Each step adds one assistant turn
 * to the prompt, so the step a call is for is how many the prompt holds past where the run began.
 *
 * A wrapper around the model because the runtime takes only `maxSteps` and offers no hook between
 * steps, the same reason `withToolSearch` is one. A configuration with no step limit, or a model the
 * runtime cannot resolve here, is returned as it is.
 */
export function answersOnLastStep(
  configuration: BuiltInAgentConfiguration,
  steps: RunSteps,
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

  const forStep = (options: CallOptions): CallOptions => {
    const turns = turnsIn(options.prompt);
    steps.before ??= turns;
    const step = turns - steps.before + 1;
    return step >= maxSteps
      ? { ...options, toolChoice: { type: "none" } }
      : options;
  };
  const wrapped: Model = {
    specificationVersion: "v3",
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,
    doGenerate: (options) => inner.doGenerate(forStep(options)),
    doStream: (options) => inner.doStream(forStep(options)),
  };
  return { ...configuration, model: wrapped };
}

function isModel(model: unknown): model is Model {
  return (
    typeof model === "object" &&
    model !== null &&
    (model as { specificationVersion?: unknown }).specificationVersion === "v3"
  );
}
