import type { Answer } from "../src/fakeNative/control";
import type { Problem } from "../src/Problem";

type Parsed = { ok: true; value: unknown } | { error: string };

function parseJson(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `The JSON is not valid: ${message}` };
  }
}

/** Turns what a person typed into an answer, or says what is wrong with it. */
export function parseAnswer(
  mode: Exclude<Answer["mode"], "script">,
  text: string,
  ms?: number,
): { answer: Answer } | { error: string } {
  if (mode === "never") return { answer: { mode: "never" } };
  if (
    mode === "delay" &&
    (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0)
  ) {
    return { error: "The delay needs a number of milliseconds, 0 or more." };
  }
  const parsed = parseJson(text);
  if ("error" in parsed) return parsed;
  const { value } = parsed;
  if (mode === "value") return { answer: { mode: "value", value } };
  if (mode === "delay") {
    return { answer: { mode: "delay", ms: ms as number, value } };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { said?: unknown }).said !== "string"
  ) {
    return { error: "A problem needs a said text." };
  }
  return { answer: { mode: "fail", problem: value as Problem } };
}
