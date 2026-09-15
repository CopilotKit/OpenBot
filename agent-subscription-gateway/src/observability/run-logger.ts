export type RunOutcome = "finished" | "failed" | "cancelled";

export interface RunLogger {
  terminal(event: {
    provider: string;
    runId: string;
    outcome: RunOutcome;
  }): void;
}

export const consoleRunLogger: RunLogger = {
  terminal(event) {
    console.info(JSON.stringify({ event: "provider_run_terminal", ...event }));
  },
};
