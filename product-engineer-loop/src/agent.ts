import type { Config } from "./config.js";
import type { LinearIssue } from "./linear.js";
import {
  approveRun as approveRunPure,
  runImplement,
  runResume,
} from "./cloud.js";
import { saveRun, type TicketRun } from "./store.js";

export async function startImplement(
  config: Config,
  issue: LinearIssue,
): Promise<TicketRun> {
  const ticketRun = await runImplement(
    {
      cursorApiKey: config.cursorApiKey,
      model: config.model,
      repos: config.repos,
    },
    issue,
  );
  if (ticketRun.status === "failed") {
    await saveRun(config.runsDir, ticketRun);
    throw new Error(
      `Product Engineer run failed (run.id=${ticketRun.lastRunId}). Inspect the agent in Cursor (Filter > Source > SDK).`,
    );
  }
  await saveRun(config.runsDir, ticketRun);
  return ticketRun;
}

export async function resumeWithFeedback(
  config: Config,
  existing: TicketRun,
  feedback: string,
): Promise<TicketRun> {
  const next = await runResume(
    {
      cursorApiKey: config.cursorApiKey,
      model: config.model,
      repos: config.repos,
    },
    existing,
    feedback,
  );
  await saveRun(config.runsDir, next);
  if (next.status === "failed") {
    throw new Error(
      `Resume run failed (run.id=${next.lastRunId}). Inspect the agent in Cursor.`,
    );
  }
  return next;
}

export async function markApproved(
  config: Config,
  existing: TicketRun,
): Promise<TicketRun> {
  const next = approveRunPure(existing);
  await saveRun(config.runsDir, next);
  return next;
}
