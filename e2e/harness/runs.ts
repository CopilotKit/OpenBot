import type { APIRequestContext } from "@playwright/test";
import { serverLog } from "./stack";

/**
 * How many runs a message started, counted the two ways a release gate counts them.
 *
 * - The server's log: one `{"type":"run-model",…}` line per Bot run (`server/src/copilot.ts`,
 *   `logRunModel`), with the run's id.
 * - The conversation's own events, from Intelligence through the runtime: one `RUN_STARTED` per run.
 *
 * A message that starts two runs (a retry, a double send, a reconnect that runs again) answers twice
 * or interleaves two answers, and both counts say so.
 */

/** Where the server log ends now, so a later read sees only what came after. */
export function serverLogMark(): number {
  return serverLog().length;
}

/** The run ids the server logged since `mark` for one Bot. */
export function runsLoggedSince(mark: number, agentId: string): string[] {
  const text = serverLog().slice(mark);
  const runs: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{") || !line.includes('"run-model"')) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        agentId?: string;
        runId?: string;
      };
      if (
        entry.type === "run-model" &&
        entry.agentId === agentId &&
        entry.runId
      ) {
        runs.push(entry.runId);
      }
    } catch {}
  }
  return runs;
}

/** The `RUN_STARTED` events in a conversation's thread, by run id. */
export async function runsInConversation(
  request: APIRequestContext,
  channelId: string,
): Promise<string[]> {
  const channel = await request.get(`/api/channels/${channelId}`);
  if (!channel.ok())
    throw new Error(`GET /api/channels/${channelId}: ${channel.status()}`);
  const { threadId } = (
    (await channel.json()) as { channel: { threadId?: string } }
  ).channel;
  if (!threadId) return [];
  const response = await request.get(
    `/api/copilotkit/threads/${threadId}/events`,
  );
  if (!response.ok()) {
    throw new Error(
      `GET thread events: ${response.status()} ${await response.text()}`,
    );
  }
  const { events } = (await response.json()) as {
    events: { type: string; runId?: string }[];
  };
  return events
    .filter((event) => event.type === "RUN_STARTED")
    .map((event) => event.runId ?? "");
}
