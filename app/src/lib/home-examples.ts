const MAX_EXAMPLES = 5;
/** Long enough for a real job, short enough to sit on one line of the composer. */
const MAX_LENGTH = 80;

/** A role description's first sentence, cut at a word so it fits the placeholder. */
function firstSentence(role: string): string {
  const sentence = role.split(/(?<=[.!?])\s/)[0] ?? role;
  if (sentence.length <= MAX_LENGTH) return sentence;
  const cut = sentence.slice(0, MAX_LENGTH - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:]$/, "")}…`;
}

/**
 * Placeholder prompts for the home composer, one per Bot the person can reach, built from that
 * Bot's own role description. Taken from their Bots rather than a fixed list, so home never
 * suggests a job for a Bot they do not have. A Bot with no role has nothing to suggest and is left
 * out; no Bots at all gives no prompts, and the composer keeps its plain "Ask anything".
 */
export function homeExamples(
  agents: { name: string; roleDescription?: string | null }[],
): string[] {
  const examples: string[] = [];
  for (const agent of agents) {
    const role = agent.roleDescription?.trim();
    if (!role) continue;
    examples.push(`Ask ${agent.name}: ${firstSentence(role)}`);
    if (examples.length === MAX_EXAMPLES) break;
  }
  return examples;
}
