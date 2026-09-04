/**
 * Which coworkers the handoff panel draws a switch for, and what the count above them means.
 *
 * ITS OWN MODULE BECAUSE THE PANEL GOT THIS WRONG WHILE READING CORRECTLY. The panel joined the
 * grants the server reports against the roster the browser holds, and those two are not filtered the
 * same way. `reachable` is `botsReachableFrom`, a raw read of the `bot` grants on this coworker with
 * no visibility filter of any kind. The roster is `GET /api/agents`, which drops every coworker the
 * signed-in person has hidden — and hidden is a PER-PERSON display preference, one row per user in
 * `agent_preferences`, not a fact about the coworker.
 *
 * So an administrator who tidied a coworker off their own roster stopped being shown its inbound
 * grants. The switch was not disabled and no note appeared; the row was simply not drawn, and the
 * `N of M` above it silently dropped by one. Nothing on any other screen manages these grants, so
 * the grant could no longer be taken away at all.
 *
 * And it was still in force. The run loop asks `mayAddress`, which calls the same unfiltered
 * `botsReachableFrom` (`server/src/index.ts:346-353`), so the hop kept working while the only
 * surface that could stop it had quietly stopped listing it. A boundary you cannot see is one you
 * cannot withdraw.
 *
 * The rule, in one place so the list and the count cannot disagree again:
 *
 *  - A coworker on your roster is offered as it always was.
 *  - A coworker you have hidden is offered ONLY if it is already granted. Hiding is a preference
 *    about clutter and this screen has no business undoing it, but "taking away is always allowed"
 *    is what the panel promises, and a grant nobody can reach is the one thing it must not do.
 *  - The count is over the rows actually drawn, so it answers the question somebody reading it is
 *    asking: how many of these are on.
 */

/** The little a roster row has to carry for this to place it. */
type Placeable = { id: string; hidden: boolean };

export type HandoffRoster<T> = {
  /** The rows to draw, in order: your roster first, then anything granted that you have hidden. */
  candidates: T[];
  /** How many of `candidates` are switched on. */
  granted: number;
  /** How many rows there are, which is what `granted` is out of. */
  total: number;
};

export function handoffRoster<T extends Placeable>(input: {
  /** The coworker whose panel this is. It may not be granted itself, so it is never a row. */
  agentId: string;
  /** `GET /api/agents`: everybody this person can see and has not hidden. */
  roster: readonly T[];
  /** `GET /api/agents?hidden=true`: the ones this person has hidden from that roster. */
  hidden: readonly T[];
  /** Bot ids this coworker may address today, exactly as the server reports them. */
  reachable: readonly string[];
  /**
   * Whether this coworker can hold such a grant at all.
   *
   * False means every new grant would be refused, so only the leftovers are shown: a stale grant may
   * still be revoked, and offering switches that can only bounce off the server is what the
   * explanation above the list replaces.
   */
  grantable: boolean;
}): HandoffRoster<T> {
  const held = new Set(input.reachable);
  const isSelf = (candidate: T) => candidate.id === input.agentId;

  const offered = input.roster.filter(
    (candidate) =>
      !isSelf(candidate) && (input.grantable || held.has(candidate.id)),
  );

  /*
   * Only the granted ones, and only those the roster did not already carry.
   *
   * The two lists are mutually exclusive per person — `list` filters on `hiddenAt` being null or not
   * null — so the id check is belt and braces rather than a real case. It costs one Set and it stops
   * a duplicate row with a duplicate React key if that ever stops being true.
   */
  const shown = new Set(offered.map((candidate) => candidate.id));
  const strays = input.hidden.filter(
    (candidate) =>
      !isSelf(candidate) && held.has(candidate.id) && !shown.has(candidate.id),
  );

  const candidates = [...offered, ...strays];
  return {
    candidates,
    granted: candidates.filter((candidate) => held.has(candidate.id)).length,
    total: candidates.length,
  };
}
