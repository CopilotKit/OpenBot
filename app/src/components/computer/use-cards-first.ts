import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { approvalInboxOptions } from "@/lib/approvals";
import { useComputerControl } from "@/lib/computers/use-control";
import {
  FINAL_SIGN_IN,
  pendingSignInRequestsQueryOptions,
} from "@/lib/passwords/queries";

/**
 * THE CARDS IN A CONVERSATION THAT WAIT ON THE PERSON COME BEFORE THE COMPUTER.
 *
 * Where the Computer has no room beside the conversation (a phone, or a narrow window) it is a sheet
 * over all of it. It opens itself while the Bot browses, which is worth seeing, but then the Bot
 * stopped to ask the person to take over its browser, to sign in, or to approve a step, and the
 * card asking sat in the conversation under the sheet. So, over the conversation:
 *
 * - a card that starts waiting closes the sheet, once, so the person sees what is asked of them;
 *   opened again by the person, the sheet stays, until another card starts waiting;
 * - while a card waits, the sheet does not open itself (`cardWaiting`, for the screen's self-open).
 *
 * Beside a wide conversation the cards are already in view, and nothing here does anything.
 *
 * The cards, by what each is waiting on: the Bot's request to be taken over (its computer's
 * wheel), an approval for a step in this conversation (the approvals inbox), and a private sign-in
 * this conversation's Bot asked for (the sign-in requests, read only where the sheet covers).
 */
export function useCardsFirst({
  botId,
  threadId,
  covers,
  watching,
  close,
  computers = true,
}: {
  botId: string | undefined;
  threadId: string | undefined;
  /** The Computer would be a sheet over the conversation. */
  covers: boolean;
  /** The Computer is open. */
  watching: boolean;
  /** Close the Computer. */
  close: () => void;
  /** This OpenBot has computers for Bots, so the wheel can be read. */
  computers?: boolean;
}): { cardWaiting: boolean } {
  const { control } = useComputerControl(
    botId ?? "",
    Boolean(botId) && computers,
  );
  const inbox = useQuery(approvalInboxOptions());
  const signIns = useQuery({
    ...pendingSignInRequestsQueryOptions(),
    enabled: covers && Boolean(threadId),
  });

  const waiting: string[] = [];
  const takeOver = control?.requested ? control.request : undefined;
  if (takeOver && takeOver.status === "waiting")
    waiting.push(`take-over:${takeOver.id}`);
  for (const request of inbox.data?.requests ?? [])
    if (
      threadId &&
      request.status === "pending" &&
      request.action.threadId === threadId
    )
      waiting.push(`approval:${request.id}`);
  if (covers)
    for (const request of signIns.data ?? [])
      if (
        threadId &&
        request.threadId === threadId &&
        !FINAL_SIGN_IN.includes(request.status)
      )
        waiting.push(`sign-in:${request.id}`);
  const key = waiting.join(" ");

  const seen = useRef<ReadonlySet<string>>(new Set());
  const latest = useRef({ covers, watching, close });
  latest.current = { covers, watching, close };
  useEffect(() => {
    const now = new Set(key ? key.split(" ") : []);
    const arrived = [...now].some((card) => !seen.current.has(card));
    seen.current = now;
    if (arrived && latest.current.covers && latest.current.watching)
      latest.current.close();
  }, [key]);

  return { cardWaiting: waiting.length > 0 };
}
