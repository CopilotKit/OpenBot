import type { Message } from "@ag-ui/core";
import { useEffect, useState } from "react";
import { ConversationView } from "@/components/channels/conversation-view";
import {
  readExternalThreadMessages,
  type ExternalThreadTarget,
} from "@/lib/external/queries";

export function ExternalThreadChat({
  target,
}: {
  target: ExternalThreadTarget;
}) {
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [restoring, setRestoring] = useState(true);
  const [unreadable, setUnreadable] = useState(false);

  useEffect(() => {
    let current = true;
    setRestoring(true);
    setUnreadable(false);
    void readExternalThreadMessages(target.threadId)
      .then((stored) => {
        if (!current) return;
        setMessages(stored);
        setRestoring(false);
      })
      /*
       * A read that fails has to stop the restoring state and say so.
       *
       * Without this the promise rejects with nobody listening and the view sits on its skeleton
       * for as long as the person leaves it open — which reads as a conversation still loading
       * rather than one that could not be read, and is the state a failed `/messages` used to leave
       * behind.
       *
       * A fact about the read rather than a count of turns, because `readExternalThreadMessages`
       * either yields the stored turns or throws: it validates the body, so a 200 of the wrong
       * shape lands here instead of arriving as an empty conversation. That is enforced there and
       * not inferable from this file, which is why it is named.
       */
      .catch(() => {
        if (!current) return;
        setMessages([]);
        setUnreadable(true);
        setRestoring(false);
      });
    return () => {
      current = false;
    };
  }, [target.threadId]);

  return (
    <ConversationView
      disabled
      messages={messages}
      notice={
        <div className="pb-2 text-sm text-muted-foreground" role="status">
          <p>
            This is the canonical Slack conversation with {target.agentName}. It
            is read-only here for this demo; continue the conversation in Slack.
          </p>
          {unreadable ? (
            <p>
              This conversation could not be read. It is still in Slack; reload
              to try again.
            </p>
          ) : null}
        </div>
      }
      onSubmit={() => undefined}
      restoring={restoring}
    />
  );
}
