import { textOf } from "../agents/message-text";
/**
 * Choosing which of a Bot's tools to put in front of the model, one run at a time.
 *
 * WHY THIS EXISTS. A model picks the right tool reliably out of about ten. Past roughly fifteen the
 * choice starts to go wrong, and it goes wrong quietly: the model calls a plausible neighbour, or
 * calls nothing and answers from memory. A realistic deployment of this template clears fifteen on
 * the first afternoon, because Drive and Slack and Jira and the browser each bring several. So the
 * catalogue has to be narrowed before the model sees it, and the unit that does the narrowing is the
 * skill: a skill says what it is for in one line, and it says which tools it needs.
 *
 * THE NARROWING IS NOT A BOUNDARY, AND MUST NEVER BE MISTAKEN FOR ONE. What a Bot may call is the
 * grant, checked in `callTool` along with the policy and the audit row. This decides only what is
 * offered out of what was already granted. Everything here can be wrong, or skipped entirely, and no
 * Bot gains a single capability it did not already hold. That is why the failure direction below is
 * "offer everything" rather than "offer nothing": narrowing is an accuracy device, and failing it
 * closed would take away tools an administrator granted because a model call timed out.
 *
 * WHY THE MODEL CHOOSES AND NOT A RETRIEVER. A retrieval prefilter fails categorically. If the tool
 * the run needed is not in the retrieved set, no amount of model capability gets it back, and the
 * published result is that a prefilter at 99% recall can land at or below no prefilter at all for
 * exactly that reason. A model that picks the wrong skill is wrong in a way the next turn can fix.
 * A prefilter that drops the tool is wrong in a way nothing can. So the model chooses, retrieval (if
 * a deployment ever needs it) narrows into that choice rather than replacing it, and every uncertain
 * case here resolves towards offering more rather than less.
 */

/** One granted skill, as much of it as choosing needs. */
export type SelectableSkill = {
  slug: string;
  title: string;
  /** The one line the model reads. This is the index; see K3. */
  summary: string;
  /** What the skill says it needs, as `<serverId>/<toolName>` refs. A declaration, not a grant. */
  tools: readonly string[];
};

/** A granted tool, as much of it as narrowing needs. */
export type SelectableTool = {
  /** `<serverId>/<toolName>`, the key a grant and a declaration are both written against. */
  ref: string;
};

/**
 * Why a run ended up offered what it was offered.
 *
 * Recorded rather than inferred, because every one of these looks identical from outside: the model
 * was handed some tools. Which of them happened decides whether a wrong answer is a selection bug, a
 * deployment that never declared anything, or a model call that failed. Without the reason, all
 * three read as "the Bot did not use its tools".
 */
export type SelectionReason =
  /** Few enough tools that a model chooses well among them unaided. Nothing was narrowed. */
  | "under-floor"
  /** No granted skill declares any granted tool, so there is no unit to select over. */
  | "nothing-declared"
  /** Pass one could not answer: no key, a timeout, a malformed reply. Everything stays offered. */
  | "unavailable"
  /** Pass one answered and named no skill. Everything stays offered; see the note below. */
  | "nothing-chosen"
  /** Pass one named skills, and the offer is their tools plus everything no skill claims. */
  | "selected";

export type Selection<Tool extends SelectableTool> = {
  /** What to hand the model. Always a subset of what was granted, and never a superset. */
  offered: Tool[];
  /** The slugs pass one chose. Empty for every reason other than `selected`. */
  skills: string[];
  reason: SelectionReason;
  /** How many were granted, so a reader can see the narrowing without recomputing it. */
  granted: number;
};

/**
 * Below this, the catalogue is already inside the range a model chooses well from, so pass one is a
 * model call that buys nothing and costs a round trip on every single run.
 *
 * Twelve because the reported knee is ten to fifteen and the cost of being slightly under it is
 * nothing, while the cost of being over it is a wrong tool call nobody sees. This is a template's
 * default, not a law: a deployment that measures its own knee somewhere else should move it.
 */
export const SELECTION_FLOOR = 12;

/**
 * What pass one is asked, given the message and the skills the Bot holds.
 *
 * Deliberately biased towards choosing. The two mistakes are not symmetrical: an extra skill costs a
 * few tool definitions in the context, and a missing one costs the answer, because the tool it would
 * have loaded is not there to call. The prompt says so in as many words rather than leaving the
 * model to guess the trade, and the caller treats an empty answer as "offer everything" for the same
 * reason.
 */
export function selectionPrompt(
  text: string,
  skills: readonly SelectableSkill[],
): string {
  const catalogue = skills
    .map((skill) => `- ${skill.slug}: ${skill.title}. ${skill.summary}`)
    .join("\n");
  return [
    "You choose which capabilities to load for the message below. You are not answering it.",
    "",
    "Capabilities available:",
    catalogue,
    "",
    "Message:",
    text,
    "",
    'Reply with only JSON: {"skills": ["<slug>", ...]}.',
    "Choose every capability that might be needed, including ones you are only somewhat sure about.",
    "Choosing one that turns out to be unnecessary costs almost nothing. Failing to choose one that",
    "was needed means the work cannot be done at all, because its tools will not be loaded. When in",
    "doubt, include it. Use an empty list only when the message plainly needs none of them.",
  ].join("\n");
}

/**
 * Read pass one's answer into slugs, or `null` when it did not answer usefully.
 *
 * `null` and `[]` mean different things and the caller treats them differently: `null` is "the
 * selector did not work", `[]` is "the selector says none apply". Both currently end at the same
 * place, offering everything, but they are different facts and the audit row records which.
 *
 * Anything the model names that is not a granted skill is dropped rather than treated as an error.
 * A model inventing a slug should cost that slug, not the whole selection.
 */
export function readChosenSkills(
  answer: string,
  skills: readonly SelectableSkill[],
): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const chosen = (parsed as { skills?: unknown }).skills;
  if (!Array.isArray(chosen)) return null;
  const known = new Set(skills.map((skill) => skill.slug));
  return [
    ...new Set(
      chosen.filter(
        (slug): slug is string => typeof slug === "string" && known.has(slug),
      ),
    ),
  ];
}

/**
 * The tools a set of chosen skills asks for, intersected with what the Bot actually holds.
 *
 * The intersection is the whole safety property. A skill may name any tool: anybody signed in may
 * write one, and `skill_tools` deliberately has no foreign key and grants nothing. If a declaration
 * could widen the offer, writing a skill would be a way to hand yourself a tool, and the one surface
 * here that is not an administrator's would become the way around every surface that is.
 */
function declaredBy(
  skills: readonly SelectableSkill[],
  granted: ReadonlySet<string>,
): Set<string> {
  const refs = new Set<string>();
  for (const skill of skills) {
    for (const ref of skill.tools) if (granted.has(ref)) refs.add(ref);
  }
  return refs;
}

/**
 * Narrow one Bot's granted tools for one run.
 *
 * `choose` is pass one, injected rather than called here so this stays a plain function a test can
 * drive without a network. It may throw or return `null`; both mean "could not say", and both leave
 * every granted tool offered.
 */
export async function selectTools<Tool extends SelectableTool>(input: {
  tools: readonly Tool[];
  skills: readonly SelectableSkill[];
  /** The message this run is about. Empty is treated as "cannot say", not as "needs nothing". */
  text: string;
  choose: (
    prompt: string,
  ) => Promise<string | null> | (string | null) | Promise<never>;
  /** Overridable so a deployment that measured its own knee is not stuck with ours. */
  floor?: number;
}): Promise<Selection<Tool>> {
  const { tools, skills, text } = input;
  const floor = input.floor ?? SELECTION_FLOOR;
  const everything = (reason: SelectionReason): Selection<Tool> => ({
    offered: [...tools],
    skills: [],
    reason,
    granted: tools.length,
  });

  if (tools.length <= floor) return everything("under-floor");

  const grantedRefs = new Set(tools.map((tool) => tool.ref));
  const declared = declaredBy(skills, grantedRefs);
  // Nothing to select over. A Bot with grants and no skills is every deployment on day one, and it
  // must behave exactly as it did before this existed.
  if (declared.size === 0) return everything("nothing-declared");
  if (text.trim() === "") return everything("unavailable");

  let chosen: string[] | null = null;
  try {
    const answer = await input.choose(selectionPrompt(text, skills));
    chosen =
      typeof answer === "string" ? readChosenSkills(answer, skills) : null;
  } catch {
    // A selector that failed is not an error a person should ever see. It costs this run the
    // narrowing and nothing else, which is the behaviour that shipped before it existed.
    chosen = null;
  }
  if (chosen === null) return everything("unavailable");
  /*
   * The model says none apply, and everything stays offered anyway.
   *
   * Reading this as "offer only the tools no skill claims" would be the categorical failure the
   * header warns about: one bad judgement in pass one, and the tool the run needed is not merely
   * ranked low, it is absent. Offering everything here is the behaviour that shipped before
   * selection existed, so the worst case of a confused selector is exactly the old accuracy rather
   * than a Bot that has lost its hands.
   */
  if (chosen.length === 0) return everything("nothing-chosen");

  const wanted = declaredBy(
    skills.filter((skill) => chosen.includes(skill.slug)),
    grantedRefs,
  );
  return {
    /*
     * The chosen skills' tools, plus every granted tool no skill claims at all.
     *
     * Undeclared tools ride along on purpose. A declaration is opt-in, so an administrator can grant
     * a tool that no skill has been written for yet, and dropping it would silently remove a
     * capability somebody deliberately handed over. The offer therefore shrinks as skills come to
     * cover the catalogue, and a deployment that has declared nothing is never punished for it.
     */
    offered: tools.filter(
      (tool) => !declared.has(tool.ref) || wanted.has(tool.ref),
    ),
    skills: chosen,
    reason: "selected",
    granted: tools.length,
  };
}

/**
 * The message pass one reads: the last thing the person said.
 *
 * The last user message rather than the whole thread, because what to load is a question about the
 * turn being taken. Feeding the transcript in would make an early mention of Drive keep Drive tools
 * loaded for the rest of the conversation, which is the opposite of narrowing.
 */

export function latestUserText(
  messages: readonly { role?: string; content?: unknown }[],
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    // AG-UI allows structured content, and text parts are the only part a selector can read. See
    // textOf: a hop asks the same question of the same shapes.
    if (typeof message.content === "string") return message.content;
    const text = textOf(message.content);
    return text === "" ? "" : text;
  }
  return "";
}
