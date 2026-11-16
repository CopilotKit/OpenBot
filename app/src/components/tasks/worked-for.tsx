import { readBrief } from "@openbot/shared/orchestration";
import {
  type QueryClient,
  QueryClientContext,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { TranscriptItem } from "@/components/channels/tool-activity";
import { ToolLine } from "@/components/channels/tool-line";
import { type ApprovalInboxData, approvalInboxOptions } from "@/lib/approvals";
import { briefDuration, useSecondsSince } from "@/lib/elapsed";
import {
  type BotTask,
  type TaskTurn,
  taskKeys,
  taskListQueryOptions,
  taskTurnsQueryOptions,
} from "@/lib/tasks/queries";
import { stepsIn, type TurnWork } from "./turn-work";

/*
 * The one row a turn's work folds into in a task's thread: "Worked for 2m", opening to every step
 * and every line the Bot said on the way. Drawn as the transcript's own folded lines are
 * (`ToolLine`), so it reads as one more thing the Bot did. While the turn runs it says how long it
 * has been working, and shimmers.
 *
 * How long is the server's: the time the turn's runs took, added up, never the time it waited on
 * the person (listTaskTurns). A turn the server has no record of yet says how many steps it took.
 */

const NOTHING_WAITING: ReadonlySet<string> = new Set();
const NO_CLIENT = () => () => undefined;

/**
 * The tool calls held for the person's approval, by id: the approval inbox's open requests, as the
 * cards under a run's line read them (`PendingApprovals`). Read from the inbox the conversation
 * already keeps loaded, and followed as it changes; with no query client, nothing waits.
 */
export function useWaitingToolCalls(
  client: QueryClient | undefined,
): ReadonlySet<string> {
  const key = approvalInboxOptions().queryKey;
  const inbox = useSyncExternalStore(
    client ? (change) => client.getQueryCache().subscribe(change) : NO_CLIENT,
    () => client?.getQueryData<ApprovalInboxData>(key),
  );
  return useMemo(() => {
    const ids = (inbox?.requests ?? []).flatMap((request) =>
      (request.status === "pending" || request.left) &&
      request.action.toolCallId
        ? [request.action.toolCallId]
        : [],
    );
    return ids.length ? new Set(ids) : NOTHING_WAITING;
  }, [inbox]);
}

/**
 * Whether a thread is a task's: its first message is a Bot's brief, or a task the person has read
 * runs in it. Read from what is already loaded; a thread drawn with no query client is a task's only
 * by its brief.
 */
export function isTaskThread(
  threadId: string | undefined,
  items: readonly TranscriptItem[],
  client: QueryClient | undefined,
): boolean {
  const first = items.find(
    (item) => item.kind === "text" && item.role === "user",
  );
  if (first?.kind === "text" && readBrief(first.text) !== null) return true;
  if (!threadId || !client) return false;
  return (
    client
      .getQueryData<BotTask[]>(taskKeys.list)
      ?.some((task) => task.threadId === threadId) ?? false
  );
}

/** A turn's runs are written down as it ends: read once then, and once more a moment after. */
const READ_AGAIN_MS = 2_000;

/** What the row says, and whether it is still moving. */
function label(
  work: TurnWork,
  running: boolean,
  seconds: number | undefined,
  turn: TaskTurn | undefined,
): string {
  if (running)
    return seconds === undefined
      ? "Working"
      : `Working for ${briefDuration(seconds)}`;
  if (turn) return `Worked for ${briefDuration(turn.workedSeconds)}`;
  const steps = stepsIn(work);
  return steps === 0
    ? "Worked on it"
    : `Worked through ${steps} ${steps === 1 ? "step" : "steps"}`;
}

export function WorkedFor({
  threadId,
  work,
  last,
  children,
}: {
  threadId: string | undefined;
  work: TurnWork;
  /** This is the thread's newest turn, the one a task that reads Working is working on. */
  last: boolean;
  /** The folded rows, drawn as they would be on their own. */
  children: ReactNode;
}) {
  const client = useContext(QueryClientContext);
  return client && threadId ? (
    <TimedWork last={last} threadId={threadId} work={work}>
      {children}
    </TimedWork>
  ) : (
    <WorkLine
      text={label(work, work.running, undefined, undefined)}
      running={work.running}
    >
      {children}
    </WorkLine>
  );
}

function TimedWork({
  threadId,
  work,
  last,
  children,
}: {
  threadId: string;
  work: TurnWork;
  last: boolean;
  children: ReactNode;
}) {
  const { data: task } = useQuery({
    ...taskListQueryOptions(),
    select: (tasks) => tasks.find((one) => one.threadId === threadId),
  });
  const running =
    work.running || (last && task?.status === "working" && !task.stoppedAt);
  const since =
    running && task?.workingSince ? Date.parse(task.workingSince) : undefined;
  const seconds = useSecondsSince(
    since !== undefined && Number.isFinite(since) ? since : undefined,
  );
  // Read again soon while this turn runs, and again as it ends: its runs are written down then.
  const { data: turns } = useQuery({
    ...taskTurnsQueryOptions(task?.id ?? "", running),
    enabled: task !== undefined,
  });
  const turn = turns?.find((one) => one.askId === work.askId);
  const queryClient = useQueryClient();
  const taskId = task?.id;
  const wasRunning = useRef(running);
  useEffect(() => {
    const ended = wasRunning.current && !running;
    wasRunning.current = running;
    if (!ended || !taskId) return;
    const read = () =>
      void queryClient.invalidateQueries({ queryKey: taskKeys.turns(taskId) });
    read();
    const again = setTimeout(read, READ_AGAIN_MS);
    return () => clearTimeout(again);
  }, [running, taskId, queryClient]);
  return (
    <WorkLine
      text={label(
        work,
        running,
        since === undefined ? undefined : seconds,
        turn,
      )}
      running={running}
    >
      {children}
    </WorkLine>
  );
}

function WorkLine({
  text,
  running,
  children,
}: {
  text: string;
  running: boolean;
  children: ReactNode;
}) {
  return (
    <div data-slot="worked-for" data-running={running || undefined}>
      <ToolLine bare label={text} running={running}>
        <div className="space-y-3 py-1 text-sm">{children}</div>
      </ToolLine>
    </div>
  );
}
