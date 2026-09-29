/**
 * Which Bots a connector screen draws a row for, when the rows are one app's or one tool's grants.
 *
 * THE RULE `handoffRoster` STATES FOR THE HANDOFF PANEL, AFTER THE SAME MISTAKE. The roster is
 * `GET /api/agents`, which drops every Bot the signed-in person has hidden. A tool's `grantedTo` is
 * not filtered by hiding at all, because hiding is a per-person display preference, one row per user
 * in `agent_preferences`, and not a fact about the Bot.
 *
 * So an administrator who tidied a Bot off their own roster stopped being shown it on the Plugins
 * screens. Its row went from By Bot and from every tool's switches, the counts above read "3 of 2
 * Bots", and its own page said there was no such Bot. The grants were still in force, and nothing on
 * any screen could take them away.
 *
 *  - A Bot on your roster is drawn as it always was.
 *  - A Bot you have hidden is drawn only if it holds one of the grants the screen is about. Hiding
 *    is about clutter and a grant screen has no business undoing it, but a grant nobody can reach is
 *    the one thing a grant screen must not have.
 */
export function grantRoster<T extends { id: string }>(input: {
  /** `GET /api/agents`: everybody this person can see and has not hidden. */
  roster: readonly T[];
  /** `GET /api/agents?hidden=true`: the ones this person has hidden from that roster. */
  hidden: readonly T[];
  /** The Bot ids holding any grant this screen shows, exactly as the server reports them. */
  holders: Iterable<string>;
}): T[] {
  const holding = new Set(input.holders);
  /*
   * The two lists are mutually exclusive per person, since `list` filters on `hiddenAt` being null
   * or not, so this only stops a duplicate row and a duplicate React key if that ever changes.
   */
  const shown = new Set(input.roster.map((bot) => bot.id));
  return [
    ...input.roster,
    ...input.hidden.filter((bot) => holding.has(bot.id) && !shown.has(bot.id)),
  ];
}
