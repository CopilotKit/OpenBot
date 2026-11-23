import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ActivityLog } from "@/components/computer/activity-log";
import {
  commandStatus,
  TerminalBlock,
} from "@/components/computer/terminal-block";
import {
  detailsOf,
  outputOf,
  readOutcome,
  recordActivity,
} from "@/lib/computers/activity";
import { failedComputerCall } from "@/lib/computers/call";
import { queryClient } from "@/query-client";

/**
 * A Bot's command as the conversation and the Activity pane draw it, as a page of its own for
 * command-card-layout.test.tsx to bundle and load in a real browser.
 *
 * The conversation's card for a command that ran, from the gate's answer as the conversation keeps
 * it (a JSON string), and the Activity pane with that command and one the gate refused, which must
 * read "Didn't run", never "Exit 0". In the chat's column, at the window's width.
 */
const COMMAND = "ls ~/reports && wc -l ~/reports/*.csv";

/** What the gate answered, as the conversation keeps it: the step's result, as text. */
const ran = JSON.stringify({
  ok: true,
  exitCode: 0,
  stdout:
    "april.csv\nmarch.csv\n  1204 /root/reports/april.csv\n   987 /root/reports/march.csv\n  2191 total\n",
  stderr: "",
  finishedAt: "2026-11-23T05:16:10.000Z",
});
const outcome = readOutcome(ran) ?? { ok: false };

recordActivity("command-card", [
  {
    id: "refused",
    did: detailsOf(
      "command",
      { command: "cat ~/reports/notes.md" },
      failedComputerCall(400, {
        error: "That unanswered tool call is not saved in this conversation.",
      }),
    ),
    finishedAt: Date.parse("2026-11-23T05:15:40.000Z"),
  },
  {
    id: "ran",
    did: detailsOf("command", { command: COMMAND }, outcome),
    finishedAt: Date.parse("2026-11-23T05:16:10.000Z"),
  },
]);

function Page() {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <section aria-label="Conversation" data-part="conversation">
          <TerminalBlock
            command={COMMAND}
            computerId="command-card"
            output={outputOf(outcome)}
            status={commandStatus({
              running: false,
              ...(typeof outcome.exitCode === "number"
                ? { exitCode: outcome.exitCode }
                : {}),
            })}
          />
        </section>
        <section
          aria-label="Activity"
          className="rounded-xl border border-border bg-card p-3"
          data-part="activity"
        >
          <ActivityLog computerId="command-card" />
        </section>
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <Page />
    </QueryClientProvider>,
  );
