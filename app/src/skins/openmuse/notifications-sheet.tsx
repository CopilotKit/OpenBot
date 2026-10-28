import { IconBell, IconHandStop } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { WaitingForYou } from "@/components/approvals/waiting";
import { approvalInboxOptions } from "@/lib/approvals";
import { waitingOnYou } from "./model";
import { LinkRow, MuseEmpty, MuseSheet } from "./ui";

/**
 * The bell: what every Bot is waiting on the person for. The list is OpenBot's own `WaitingForYou`,
 * so every question, approval, choice and detail is exactly the one OpenBot's Bot pages show.
 */
export function NotificationsSheet({ onClose }: { onClose: () => void }) {
  const inbox = useQuery(approvalInboxOptions());
  const nothing =
    inbox.data !== undefined && waitingOnYou(inbox.data).count === 0;
  return (
    <MuseSheet
      onClose={onClose}
      subtitle="Approvals and questions your Bots are waiting on."
      title="Needs you"
    >
      <div className="flex flex-col gap-3.5">
        {nothing ? (
          <MuseEmpty
            detail="When a Bot needs your OK or an answer, it shows up here."
            icon={IconBell}
            title="You're all caught up"
          />
        ) : (
          <WaitingForYou />
        )}
        <LinkRow
          detail="What your Bots may do without asking"
          icon={IconHandStop}
          render={<Link onClick={onClose} to="/settings/approvals" />}
          tint="lavender"
          title="Approval rules"
        />
      </div>
    </MuseSheet>
  );
}
