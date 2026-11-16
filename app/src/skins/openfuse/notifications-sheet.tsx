import { IconBell, IconHandStop } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { WaitingForYou } from "@/components/approvals/waiting";
import { useWaitingCount } from "@/components/bot-profile/attention";
import { NeedsYouRows, useNeedsYou } from "@/components/needs-you/needs-you";
import { countsAsWaiting, heldByTaskOf } from "@/lib/tasks/groups";
import { FuseEmpty, FuseSheet, LinkRow } from "./ui";

/**
 * The bell: what every Bot is waiting on the person for, the things its number counts (OpenBot's
 * own count, `useWaitingCount`). The rows are OpenBot's own: `WaitingForYou` for questions and
 * approvals, and the task rows for tasks waiting on the person. A question inside a task is listed
 * once, as the task.
 */
export function NotificationsSheet({ onClose }: { onClose: () => void }) {
  const waiting = useWaitingCount();
  const { tasks, done } = useNeedsYou();
  const waitingTasks = tasks.filter(countsAsWaiting);
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
            <WaitingForYou heldByTask={heldByTaskOf([...tasks, ...done])} />
            <NeedsYouRows items={[]} tasks={waitingTasks} />
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
