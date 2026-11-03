import { requireOptionalNativeModule } from "expo-modules-core";

/**
 * Needle (cactus-compute/needle, Apache-2.0) on the phone: a tiny model that turns a request into
 * calls to the tools it is given. It does not chat. Android only; elsewhere `needle` is null.
 */
type NeedleNative = {
  isAvailable(): boolean;
  prepare(system: string, toolsJson: string): Promise<void>;
  complete(text: string): Promise<string>;
};

const native = requireOptionalNativeModule<NeedleNative>("OpenBotNeedle");

export type NeedleTool = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
};

export type NeedleCall = { name: string; arguments: Record<string, unknown> };

export type NeedleAnswer = {
  calls: NeedleCall[];
  /** Calls the engine held back because it wasn't sure. Ask before doing them. */
  unsure: NeedleCall[];
  confidence: number | null;
  reasoning: string;
};

/** Whether this phone build carries Needle's engine and model. */
export function needleAvailable(): boolean {
  try {
    return Boolean(native?.isAvailable());
  } catch {
    return false;
  }
}

function calls(value: unknown): NeedleCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    entry && typeof entry === "object" && typeof entry.name === "string"
      ? [
          {
            name: entry.name,
            arguments:
              entry.arguments && typeof entry.arguments === "object"
                ? (entry.arguments as Record<string, unknown>)
                : {},
          },
        ]
      : [],
  );
}

/** Reads the engine's JSON. Exported for tests. */
export function readNeedleAnswer(raw: string): NeedleAnswer {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.error === "number" || parsed.success === false)
    throw new Error("Needle couldn't work that out.");
  return {
    calls: calls(parsed.function_calls),
    unsure: calls(parsed.suppressed_calls),
    confidence:
      typeof parsed.confidence === "number" ? parsed.confidence : null,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
  };
}

/** One request, on the phone, with no connection. */
export async function askNeedle(
  text: string,
  tools: NeedleTool[],
  facts: string,
): Promise<NeedleAnswer> {
  if (!native) throw new Error("This phone build has no Needle.");
  await native.prepare(facts, JSON.stringify(tools));
  return readNeedleAnswer(await native.complete(text));
}
