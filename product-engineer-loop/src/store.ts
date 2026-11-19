import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TicketRun } from "./types.js";

export type { TicketRun, RunStatus, TicketRunHistoryEntry } from "./types.js";
export { extractPrUrl, BUSY_STATUSES } from "./types.js";

function pathFor(runsDir: string, ticketId: string): string {
  const safe = ticketId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "_");
  return join(runsDir, `${safe}.json`);
}

export async function loadRun(
  runsDir: string,
  ticketId: string,
): Promise<TicketRun | null> {
  try {
    const raw = await readFile(pathFor(runsDir, ticketId), "utf8");
    return JSON.parse(raw) as TicketRun;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveRun(runsDir: string, run: TicketRun): Promise<void> {
  await mkdir(runsDir, { recursive: true });
  const next = { ...run, updatedAt: new Date().toISOString() };
  await writeFile(
    pathFor(runsDir, run.ticketId),
    `${JSON.stringify(next, null, 2)}\n`,
  );
}
