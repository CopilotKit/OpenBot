import { isWorking, type MergedRoutine } from "@/lib/routines/merged";

/**
 * The merged routines, one group per Bot, for the Routines place.
 *
 * A group keeps its rows in the order `mergeRoutines` gave them. A Bot with a row that is working
 * comes before a Bot whose rows are all off; Bots with the same standing go in name order, and a
 * tie keeps the order the Bots first appear in.
 */
export function groupRoutinesByBot(
  rows: readonly MergedRoutine[],
  nameOf: (agentId: string) => string,
): { agentId: string; rows: MergedRoutine[] }[] {
  const groups = new Map<string, MergedRoutine[]>();
  for (const row of rows) {
    const group = groups.get(row.agentId);
    if (group) group.push(row);
    else groups.set(row.agentId, [row]);
  }
  return [...groups]
    .map(([agentId, groupRows], index) => ({
      agentId,
      rows: groupRows,
      index,
      working: groupRows.some(isWorking),
    }))
    .sort(
      (a, b) =>
        Number(b.working) - Number(a.working) ||
        nameOf(a.agentId).localeCompare(nameOf(b.agentId), undefined, {
          sensitivity: "base",
        }) ||
        a.index - b.index,
    )
    .map(({ agentId, rows: groupRows }) => ({ agentId, rows: groupRows }));
}
