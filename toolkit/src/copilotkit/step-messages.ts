import {
  type BuiltInAgentClassicConfig,
  type BuiltInAgentConfiguration,
  resolveModel,
} from "@copilotkit/runtime/v2";

// The model contract of the runtime we ship, as `last-step.ts` reads it.
type Model = Extract<
  BuiltInAgentClassicConfig["model"],
  { specificationVersion: "v3" }
>;
type CallOptions = Parameters<Model["doStream"]>[0];
type StreamResult = Awaited<ReturnType<Model["doStream"]>>;
type Part = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/**
 * Each model step of a built-in Bot's run in an assistant message of its own.
 *
 * WHY. The runtime's `BuiltInAgent` names the message a tool call belongs to after the last text the
 * model wrote, and starts a new one only when the model writes again. A run that searched in one
 * step and drew a chart in the next, with no words between, put both calls in ONE message, which is
 * exactly how a step that asked for the search and the chart together looks. So nothing reading the
 * conversation could tell a chart drawn from results already read from one drawn before them, and
 * the history went back to the model saying it had asked for both at once. A step is what
 * `shared/tool-steps.ts` holds to Anthropic's rules for parallel tool use, so a step has to be a
 * message.
 *
 * HOW. Every step is one call of the model's `doStream`. Each one starts with an empty block of text
 * under a name of its own: the runtime takes the name as the message for the calls that follow, and
 * draws nothing for it, since nothing is written in it. The AI SDK leaves an empty block of text out
 * of what it sends the model back, so the conversation the model reads is unchanged. A step that
 * writes before it calls a tool moves its calls to the message of its own words, as before.
 *
 * A configuration the runtime builds from a factory, or a model it cannot resolve here, is returned
 * as it is.
 */
export function oneMessagePerStep(
  configuration: BuiltInAgentConfiguration,
  newId: () => string = () => crypto.randomUUID(),
): BuiltInAgentConfiguration {
  if ("factory" in configuration) return configuration;
  let model: unknown;
  try {
    model = resolveModel(configuration.model, configuration.apiKey);
  } catch {
    return configuration;
  }
  if (!isModel(model)) return configuration;
  const inner = model;

  const doStream = async (options: CallOptions): Promise<StreamResult> => {
    const result = await inner.doStream(options);
    return { ...result, stream: startedApart(result.stream, newId()) };
  };

  const wrapped: Model = {
    specificationVersion: "v3",
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,
    doGenerate: (options) => inner.doGenerate(options),
    doStream,
  };
  return { ...configuration, model: wrapped };
}

/** The step's stream with an empty block of text named `id` after its start, or first if it has none. */
function startedApart(
  stream: ReadableStream<Part>,
  id: string,
): ReadableStream<Part> {
  let marked = false;
  const mark = (controller: TransformStreamDefaultController<Part>) => {
    marked = true;
    controller.enqueue({ type: "text-start", id } as Part);
    controller.enqueue({ type: "text-end", id } as Part);
  };
  return stream.pipeThrough(
    new TransformStream<Part, Part>({
      transform(part, controller) {
        if (marked) {
          controller.enqueue(part);
          return;
        }
        if (part.type === "stream-start") {
          controller.enqueue(part);
          mark(controller);
          return;
        }
        mark(controller);
        controller.enqueue(part);
      },
    }),
  );
}

function isModel(model: unknown): model is Model {
  return (
    typeof model === "object" &&
    model !== null &&
    (model as { specificationVersion?: unknown }).specificationVersion === "v3"
  );
}
