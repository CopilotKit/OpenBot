import type { Message } from "@ag-ui/core";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  answersFor,
  asksForApproval,
  botRaisedInterrupts,
  type HeldInterrupt,
  type InterruptAnswer,
  interruptedCall,
} from "@/lib/copilot/bot-raised-interrupts";
import { type Failure, failureOf, failureSaid } from "@/lib/load-failure";

type InterruptedAgent = {
  pendingInterrupts: HeldInterrupt[];
  messages: readonly Message[];
  isRunning: boolean;
  subscribe(subscriber: {
    onRunInitialized?: () => void;
    onRunFinalized?: () => void;
    onRunFailed?: () => void;
  }): { unsubscribe(): void };
};

/**
 * What a Bot stopped its own run to ask, with the person's answer to it.
 *
 * Only for a wait the Bot raised itself; OpenBot's own approvals have their cards
 * (`bot-raised-interrupts.ts` says which is which). The answer is sent as the next run's `resume`,
 * which is how AG-UI carries one.
 */
export function BotApprovalNotice({
  agent,
  botName,
  ready,
  run,
}: {
  agent: InterruptedAgent;
  botName: string;
  ready: boolean;
  run: (resume: InterruptAnswer[]) => Promise<unknown>;
}) {
  const [, redraw] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Failure | null>(null);
  // The agent's interrupts change when a run ends or starts, which is not a render of its own.
  useEffect(() => {
    const again = () => redraw((count) => count + 1);
    const watching = agent.subscribe({
      onRunInitialized: again,
      onRunFinalized: again,
      onRunFailed: again,
    });
    return () => watching.unsubscribe();
  }, [agent]);

  const waiting = ready ? botRaisedInterrupts(agent.pendingInterrupts) : [];
  if (waiting.length === 0 || agent.isRunning) return null;
  const approvals = waiting.filter(asksForApproval);

  const answer = async (approved: boolean) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await run(answersFor(agent.pendingInterrupts, approved));
    } catch (error) {
      setProblem(failureOf(error, "Couldn't send your answer. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="mb-3 flex flex-col gap-2 rounded-md border bg-warning/10 p-3 text-sm"
      data-bot-approval
      role="status"
    >
      {approvals.length > 0 ? (
        <p className="font-medium">{botName} asks before it goes on</p>
      ) : (
        <p className="font-medium">
          {botName} is waiting for an answer this app can't give
        </p>
      )}
      {waiting.map((interrupt) => {
        const call = interruptedCall(interrupt, agent.messages);
        // What the Bot asks, in its own words. Not an error's: nothing here failed.
        const asked = interrupt.message;
        return (
          <div className="flex min-w-0 flex-col gap-1" key={interrupt.id}>
            {/*
             * The call itself when the conversation has it: its name and what it was given, as the
             * person would check them. A harness words its question for a terminal (`Approve
             * "shell"? Input: {...}`), so its words are only for a wait that names no call.
             */}
            {call ? (
              <>
                <p>
                  Use <span className="font-medium">{call.name}</span>
                </p>
                <p className="min-w-0 break-words font-mono text-muted-foreground text-xs">
                  {call.args}
                </p>
              </>
            ) : asked ? (
              <p className="break-words">{asked}</p>
            ) : null}
          </div>
        );
      })}
      {problem ? (
        <p className="text-destructive" role="alert">
          {failureSaid(problem)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {approvals.length > 0 ? (
          <>
            <Button disabled={busy} onClick={() => void answer(true)} size="sm">
              Allow
            </Button>
            <Button
              disabled={busy}
              onClick={() => void answer(false)}
              size="sm"
              variant="outline"
            >
              Don't allow
            </Button>
          </>
        ) : (
          <Button
            disabled={busy}
            onClick={() => void answer(false)}
            size="sm"
            variant="outline"
          >
            Carry on without it
          </Button>
        )}
      </div>
    </div>
  );
}
