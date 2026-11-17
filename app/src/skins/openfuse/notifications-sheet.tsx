import { IconBell, IconHandStop } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useHeldAnswers, WaitingForYou } from "@/components/approvals/waiting";
import { ActivityRow } from "@/components/bot-profile/activity";
import { useWaitingCount } from "@/components/bot-profile/attention";
import { NeedsYouRows, useNeedsYou } from "@/components/needs-you/needs-you";
import { useStalledHandoffs } from "@/components/needs-you/stalled-handoffs";
import {
  countsAsWaiting,
  heldByTaskOf,
  type ListedTask,
} from "@/lib/tasks/groups";
import { FuseEmpty, FuseSheet, LinkRow } from "./ui";

/**
 * The bell: what every Bot is waiting on the person for, the things its number counts (OpenBot's
 * own count, `useWaitingCount`), every one of them. The rows are OpenBot's own: `WaitingForYou` for
 * questions and approvals, a Bot's Activity row for a hand-off that ran out of tries, and the task
 * rows for tasks waiting on the person. A question inside a task is listed once, as the task.
 */
export function NotificationsSheet({ onClose }: { onClose: () => void }) {
  const waiting = useWaitingCount();
  const { tasks, done } = useNeedsYou();
  /*
   * A task waiting on a question or an action in its own conversation is listed once, as that wait's
   * own row, where it is answered; every other task waiting on the person is its task row.
   */
  const heldAnswer = useHeldAnswers();
  const answeredHere = (listed: ListedTask) =>
    listed.status === "needs_input" && heldAnswer(listed.task) !== undefined;
  const waitingTasks = tasks.filter(
    (listed) => countsAsWaiting(listed) && !answeredHere(listed),
  );
  const stalledHandoffs = useStalledHandoffs();
  return (
    <FuseSheet
      onClose={onClose}
      subtitle="Approvals, questions and tasks your Bots are waiting on."
      title="Needs you"
    >
      <div className="flex flex-col gap-3.5">
        {waiting === 0 ? (
          <FuseEmpty
            detail="When a Bot needs your OK or an answer, it shows up here."
            icon={IconBell}
            title="You're all caught up"
          />
        ) : (
          <>
            <WaitingForYou
              heldByTask={heldByTaskOf(
                [...tasks, ...done].filter((listed) => !answeredHere(listed)),
              )}
            />
            <NeedsYouRows
              items={[]}
              lead={stalledHandoffs.map(({ botId, item }) => (
                <ActivityRow agentId={botId} item={item} key={item.id} live />
              ))}
              tasks={waitingTasks}
            />
          </>
        )}
        <LinkRow
          detail="What your Bots may do without asking"
          icon={IconHandStop}
          render={<Link onClick={onClose} to="/settings/approvals" />}
          tint="lavender"
          title="Approvals"
        />
      </div>
    </FuseSheet>
  );
}
