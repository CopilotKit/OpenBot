import { useEffect, useRef, useState } from "react";
import { readControl } from "@/lib/computers/control";
import {
  forgetHandoff,
  hasActiveHandoff,
  type PendingHandoff,
  pendingHandoff,
  rememberHandoff,
  wasHandoffAnswered,
} from "@/lib/computers/handoff";
import {
  findPendingTool,
  type HandoffAgent,
  resumeHandoffTask,
} from "@/lib/copilot/handoff-resume";

/** SDK reconnect replays human-in-the-loop tools only; ordinary frontend handlers need this action. */
export function HandoffResumeNotice({
  botId,
  agent,
  ready,
  run,
}: {
  botId: string;
  agent: HandoffAgent;
  ready: boolean;
  run: () => Promise<unknown>;
}) {
  const [pending, setPending] = useState<PendingHandoff | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      let stored = pendingHandoff(botId);
      if (!stored) {
        const state = await readControl(botId).catch(() => null);
        const request = state?.request;
        if (request?.toolCallId) {
          const candidate = {
            requestId: request.id,
            toolCallId: request.toolCallId,
          };
          if (
            !wasHandoffAnswered(botId, candidate.requestId) &&
            findPendingTool(agent.messages, candidate)
          ) {
            rememberHandoff(botId, candidate.requestId, candidate.toolCallId);
            stored = candidate;
          }
        }
      }
      if (!live) return;
      if (stored && !findPendingTool(agent.messages, stored)) {
        const toolCallId = stored.toolCallId;
        const answered = agent.messages.some(
          (m) => m.role === "tool" && m.toolCallId === toolCallId,
        );
        if (answered) forgetHandoff(botId, stored.requestId);
        stored = null;
      }
      /*
       * Nothing to resume while a call in this tab is still waiting on the request, nor once one has taken its answer:
       * a person who left the conversation while holding control comes back to a new chat whose restored call looks
       * unanswered, while the turn that was running carried on with the answer and the reply is on its way here.
       */
      setPending(
        stored &&
          !hasActiveHandoff(botId, stored.requestId) &&
          !wasHandoffAnswered(botId, stored.requestId)
          ? stored
          : null,
      );
      timer = setTimeout(() => void check(), 1000);
    };
    void check();
    return () => {
      live = false;
      clearTimeout(timer);
      controller.current?.abort("detached");
    };
  }, [botId, agent, ready]);

  const resume = async () => {
    if (!pending || busy) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setProblem(null);
    try {
      await resumeHandoffTask(botId, pending, agent, run, abort.signal);
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : "Couldn't resume the task.",
      );
    } finally {
      setBusy(false);
      controller.current = null;
    }
  };
  if (!pending && !busy && !problem) return null;
  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-amber-500/10 p-3 text-sm"
      role="status"
    >
      <span>
        {problem ??
          (busy
            ? "Waiting for this browser handoff to finish."
            : "A browser task is paused in this conversation.")}
      </span>
      {busy ? (
        <button
          type="button"
          className="underline"
          onClick={() => controller.current?.abort()}
        >
          Stop waiting
        </button>
      ) : (
        <button
          type="button"
          className="underline"
          disabled={!pending || agent.isRunning}
          onClick={() => void resume()}
        >
          Resume task
        </button>
      )}
    </div>
  );
}
