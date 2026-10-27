import { IconBell, IconHandStop } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { approvalInboxOptions } from "@/lib/approvals";
import { ApprovalCard, QuestionCard } from "./approvals";
import { waitingOnYou } from "./model";
import { ErrorNotice, LinkRow, MuseEmpty, MuseSheet } from "./ui";

/**
 * The bell: what every Bot is waiting on the person for, from OpenBot's approval inbox. Questions
 * first, because a run is paused on each; then actions waiting for an OK.
 */
export function NotificationsSheet({ onClose }: { onClose: () => void }) {
  const inbox = useQuery(approvalInboxOptions());
  const { requests, questions } = waitingOnYou(inbox.data);
  return (
    <MuseSheet
      onClose={onClose}
      subtitle="Approvals and questions your Bots are waiting on."
      title="Needs you"
    >
      <div className="flex flex-col gap-3.5">
        {inbox.isPending ? null : inbox.error ? (
          <ErrorNotice error={inbox.error.message} />
        ) : requests.length + questions.length === 0 ? (
          <MuseEmpty
            detail="When a Bot needs your OK or an answer before it carries on, it waits here."
            icon={IconBell}
            title="You're all caught up"
          />
        ) : (
          <>
            {questions.map((question) => (
              <QuestionCard key={question.id} question={question} />
            ))}
            {requests.map((request) => (
              <ApprovalCard key={request.id} request={request} />
            ))}
          </>
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
