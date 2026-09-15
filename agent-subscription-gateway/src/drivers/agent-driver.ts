export interface DriverRun {
  threadId: string;
  runId: string;
  messages: readonly unknown[];
  context: readonly unknown[];
  state: Record<string, unknown>;
  forwardedProps: Record<string, unknown>;
  workspacePath?: string;
}

export interface DriverResumeRun extends DriverRun {
  sessionId: string;
}

export interface DriverRunContext {
  signal: AbortSignal;
}

export type DriverEvent =
  | { type: "text"; delta: string }
  | { type: "session"; sessionId: string }
  | {
      type: "activity";
      message: string;
      data?: Record<string, unknown>;
    };

export interface AgentDriver {
  readonly provider: string;
  readonly version: string;
  isAuthReady(): Promise<boolean>;
  start(run: DriverRun, context: DriverRunContext): AsyncIterable<DriverEvent>;
  resume(
    run: DriverResumeRun,
    context: DriverRunContext,
  ): AsyncIterable<DriverEvent>;
  cancel(runId: string): Promise<void>;
}

export class SafeDriverError extends Error {
  constructor(readonly publicMessage: string) {
    super(publicMessage);
    this.name = "SafeDriverError";
  }
}
