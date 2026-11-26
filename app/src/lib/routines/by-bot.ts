import type { AgentProfile } from "@/lib/agents/queries";
import { intervalLabel, type MergedRoutine, routineDoes } from "./merged";
import { lastRunLabel, scheduleWords } from "./words";

export type RowTone = "running" | "warning" | "muted" | "normal";

/** The one fact a row says about itself, and how loudly. */
export type RowFact = { text: string; tone: RowTone };

type BotName = Pick<AgentProfile, "id" | "name" | "avatarSeed">;

export type BotGroup = {
  botId: string;
  name: string;
  seed: string;
  hidden: boolean;
  /** Whether a Bot list knows this Bot; false for "A Bot", one only a row names. */
  known: boolean;
  rows: MergedRoutine[];
};

/** Whether a row is working at this moment. A goal is running when a routine that runs it is. */
export function isRunning(row: MergedRoutine): boolean {
  switch (row.kind) {
    case "routine":
      return (
        row.routine.lastRun !== null && row.routine.lastRun.status === null
      );
    case "goal":
      return row.routines.some(
        (routine) =>
          routine.lastRun !== null && routine.lastRun.status === null,
      );
    case "check-in":
      return row.checkIn.lastStatus === "running";
  }
}

export function rowName(row: MergedRoutine): string {
  switch (row.kind) {
    case "routine":
      return row.routine.title ?? routineDoes(row.routine);
    case "goal":
      return row.goal.title;
    case "check-in":
      return row.checkIn.subject || "Everything it reads";
  }
}

/** What went wrong with a row last time, if anything did. */
function warning(row: MergedRoutine): string | null {
  switch (row.kind) {
    case "routine": {
      const status = row.routine.lastRun?.status;
      if (status === "failed" || status === "skipped")
        return lastRunLabel(row.routine.lastRun).text;
      return row.routine.conversation.gone
        ? "Its conversation was deleted"
        : null;
    }
    case "goal":
      return null;
    case "check-in":
      return row.checkIn.lastStatus === "error"
        ? "Couldn't check last time"
        : null;
  }
}

/** The row's own words for being switched off: paused, or for a goal, completed too. */
function off(row: MergedRoutine): string | null {
  switch (row.kind) {
    case "routine":
      return row.routine.enabled ? null : "Paused";
    case "goal":
      if (row.goal.status === "completed") return "Completed";
      return row.goal.status === "paused" ? "Paused" : null;
    case "check-in":
      return row.checkIn.enabled ? null : "Paused";
  }
}

/** Whether a row is switched off: paused, or for a goal, completed too. */
export function isOff(row: MergedRoutine): boolean {
  return off(row) !== null;
}

/**
 * The one fact a row says, the first of these that applies: running, a warning, off, and otherwise
 * when it starts. `goalStarts` is a goal's starts in words, which only the caller has read.
 */
export function rowFact(
  row: MergedRoutine,
  goalStarts: string | null,
): RowFact {
  if (isRunning(row)) return { text: "Running now", tone: "running" };
  const problem = warning(row);
  if (problem) return { text: problem, tone: "warning" };
  const paused = off(row);
  if (paused) return { text: paused, tone: "muted" };
  switch (row.kind) {
    case "routine":
      return { text: scheduleWords(row.routine), tone: "normal" };
    case "goal":
      return { text: goalStarts ?? "", tone: "normal" };
    case "check-in":
      return {
        text: `Checks ${intervalLabel(row.checkIn.intervalMinutes).toLowerCase()}`,
        tone: "normal",
      };
  }
}

/** When a row starts next, or null when nothing is set to start it. */
function nextStart(row: MergedRoutine): number | null {
  switch (row.kind) {
    case "routine":
      return row.routine.enabled ? Date.parse(row.routine.nextRunAt) : null;
    case "check-in":
      return row.checkIn.enabled ? Date.parse(row.checkIn.nextRunAt) : null;
    case "goal": {
      const starts = row.routines
        .filter((routine) => routine.enabled)
        .map((routine) => Date.parse(routine.nextRunAt));
      return starts.length ? Math.min(...starts) : null;
    }
  }
}

/** Running; warning; enabled with a start; goals with no start; off, paused or completed. */
function band(row: MergedRoutine): number {
  if (isRunning(row)) return 0;
  if (warning(row)) return 1;
  if (off(row)) return 4;
  return nextStart(row) === null ? 3 : 2;
}

function sortedRows(rows: readonly MergedRoutine[]): MergedRoutine[] {
  return rows
    .map((row, index) => ({
      row,
      index,
      band: band(row),
      start: nextStart(row),
    }))
    .sort(
      (a, b) =>
        a.band - b.band ||
        (a.band === 2 ? (a.start ?? 0) - (b.start ?? 0) : 0) ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}

/**
 * One Bot's routines that are running or lined up to start, in the Routines page's order: running
 * first, then those with a warning, then by when they next start. Paused and completed ones, and
 * goals nothing starts but asking, are left out. What a Bot's page shows under Routines.
 */
export function runningAndScheduled(
  rows: readonly MergedRoutine[],
  botId: string,
): MergedRoutine[] {
  return sortedRows(
    rows.filter(
      (row) =>
        row.agentId === botId &&
        !isOff(row) &&
        (isRunning(row) || nextStart(row) !== null),
    ),
  );
}

/**
 * The rows as one group per Bot that has any: the Bots in `shown` first, in its order, then those in
 * `hidden`, in its order, then any other Bot a row names, as "A Bot". Inside a group the rows run in
 * five bands (see `band`); ties keep the order the rows came in.
 */
export function routinesByBot(
  rows: readonly MergedRoutine[],
  shown: readonly BotName[],
  hidden: readonly BotName[],
): BotGroup[] {
  const listed = new Set([...shown, ...hidden].map((bot) => bot.id));
  const strays = [...new Set(rows.map((row) => row.agentId))]
    .filter((botId) => !listed.has(botId))
    .map((botId) => ({ id: botId, name: "A Bot", avatarSeed: botId }));
  // Right after a hide or an unhide a Bot can be in both lists for a moment: it is one group, in
  // the shown position.
  const shownIds = new Set(shown.map((bot) => bot.id));
  const ordered = [
    ...shown.map((bot) => ({ bot, hidden: false, known: true })),
    ...hidden
      .filter((bot) => !shownIds.has(bot.id))
      .map((bot) => ({ bot, hidden: true, known: true })),
    ...strays.map((bot) => ({ bot, hidden: false, known: false })),
  ];
  return ordered.flatMap(({ bot, hidden, known }) => {
    const mine = rows.filter((row) => row.agentId === bot.id);
    return mine.length
      ? [
          {
            botId: bot.id,
            name: bot.name,
            seed: bot.avatarSeed,
            hidden,
            known,
            rows: sortedRows(mine),
          },
        ]
      : [];
  });
}
