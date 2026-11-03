import type { SelectableSkill } from "../plugins/selection";

/**
 * Pass one of tool selection on Needle, the small tool-picking model running on this computer.
 *
 * Needle (cactus-compute/needle, Apache-2.0) does not chat: given tools, it reads a request and
 * names the ones it needs, in a few milliseconds, with a confidence score. That is exactly pass
 * one's question, "which skills does this message need", so each skill is offered to it as a tool
 * and the ones it calls are the skills chosen. The big model is not asked at all, which on a local
 * AI saves a whole slow round trip on every message.
 *
 * It never narrows on a guess. A call Needle held back for being unsure still counts as chosen
 * (choosing extra costs nothing; missing one costs the answer), and when it calls nothing, is
 * unreachable or answers oddly, this returns null and the deployment's usual chooser decides.
 */

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Below this, Needle's pick is too unsure to narrow on, and the usual chooser decides. */
export const NEEDLE_MIN_CONFIDENCE = 0.3;

/** How long one pick may take before the usual chooser takes over. Needle answers in milliseconds. */
const TIMEOUT_MS = 2000;

/** A skill as a tool Needle can call. Names are letters, digits and underscores, as tools need. */
export function needleToolName(slug: string): string {
  return `use_${slug.replace(/[^a-zA-Z0-9_]/g, "_")}`.slice(0, 64);
}

export function needleTools(skills: readonly SelectableSkill[]) {
  return skills.map((skill) => ({
    name: needleToolName(skill.slug),
    description: `${skill.title}. ${skill.summary}`.slice(0, 500),
    parameters: { type: "object", properties: {} },
  }));
}

/** The skills Needle's answer names, or null when it named none or can't be trusted. */
export function readNeedlePick(
  body: unknown,
  skills: readonly SelectableSkill[],
): string[] | null {
  if (!body || typeof body !== "object") return null;
  const answer = body as Record<string, unknown>;
  if (typeof answer.error === "string" || answer.success === false) return null;
  const confidence =
    typeof answer.confidence === "number" ? answer.confidence : null;
  if (confidence !== null && confidence < NEEDLE_MIN_CONFIDENCE) return null;
  const bySlug = new Map(
    skills.map((skill) => [needleToolName(skill.slug), skill.slug]),
  );
  const picked = new Set<string>();
  for (const key of ["function_calls", "suppressed_calls"]) {
    const calls = answer[key];
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const slug = bySlug.get((call as { name?: unknown })?.name as string);
      if (slug) picked.add(slug);
    }
  }
  return picked.size > 0 ? [...picked] : null;
}

/** A chooser for `ToolSelection.chooseFast`, talking to the Needle helper at `baseUrl`. */
export function createNeedleChooser(baseUrl: string, fetcher: Fetcher = fetch) {
  const url = `${baseUrl.replace(/\/+$/, "")}/complete`;
  return async (
    text: string,
    skills: readonly SelectableSkill[],
    signal?: AbortSignal,
  ): Promise<string[] | null> => {
    if (!text.trim() || skills.length === 0) return null;
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: text.slice(0, 4000),
          tools: needleTools(skills),
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) return null;
      return readNeedlePick(await response.json(), skills);
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  };
}

/** Whether the helper answers, for the Admin page. */
export async function needleIsUp(
  baseUrl: string,
  fetcher: Fetcher = fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(`${baseUrl.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}
