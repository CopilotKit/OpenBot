import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  cardNeededShown,
  hideCardNeeded,
  refusalAddCardUrl,
  rememberTrialUsedUpAnnounced,
  showCardNeeded,
  subscribeCardNeeded,
  trialUsedUpAnnounced,
} from "@/lib/plan/card-needed";
import {
  needsCard,
  planKeys,
  planQueryOptions,
  trialUsedUp,
} from "@/lib/plan/queries";
import { cardAction, stoppedWords, trialUsed } from "@/lib/plan/words";
import { useCurrentOrganizationId } from "@/lib/organizations/current";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/**
 * Bots can't run until a card is added: the free trial is used up, or the last payment failed.
 * Says so plainly, with the size of the trial the server sent and what OpenBot costs from here, and
 * gives an admin the one way on (`addCardUrl`, the server's verdict on who may add a card). A member
 * is told who to ask.
 *
 * One for the whole app, mounted once in the signed-in layout so every skin, and OpenBot Desktop's
 * window, which shows the same app, has it. It opens by itself once for a person in an
 * organization, when the plan read first says the trial is used up, and this browser remembers it
 * did: a reload, a link opened afresh, or coming Back from the payment page don't open it again.
 * After that it opens every time the person tries something that uses the AI (`stopIfNeedsCard`,
 * and any PLAN_REQUIRED refusal from the server). Closing it lasts until the next try.
 *
 * The plan is read again each time it opens, so the words follow what the server says now; and when
 * that read says Bots can run (a card was added on another page), it closes by itself. Opened by a
 * refusal while the plan as last read still says runs are left, who it is talking to comes from the
 * refusal, which carries the payment page only for an owner or an admin: an admin never reads the
 * member's line while the plan is read again.
 */
export function CardNeededDialog() {
  const open = useSyncExternalStore(
    subscribeCardNeeded,
    cardNeededShown,
    cardNeededShown,
  );
  const organizationId = useCurrentOrganizationId();
  const known = organizationId !== undefined;
  const read = useQuery({ ...planQueryOptions(), enabled: known });
  const personId = useQuery({ ...currentUserQueryOptions(), enabled: known })
    .data?.id;
  const plan = read.data;
  const usedUp = trialUsedUp(plan);

  // Closed when the layout holding it goes (signing out), so it never reopens by itself later.
  useEffect(() => () => hideCardNeeded(), []);

  useEffect(() => {
    if (!usedUp || !personId || !organizationId) return;
    if (trialUsedUpAnnounced(personId, organizationId)) return;
    rememberTrialUsedUpAnnounced(personId, organizationId);
    showCardNeeded();
  }, [usedUp, personId, organizationId]);

  // When it opened, so only a plan read after that can close it.
  const openedAt = useRef(0);
  useEffect(() => {
    if (!open || !known) return;
    openedAt.current = Date.now();
    void queryClient.invalidateQueries({ queryKey: planKeys.all });
  }, [open, known]);
  useEffect(() => {
    if (!open || !plan || read.dataUpdatedAt < openedAt.current) return;
    const runs =
      !plan.required || plan.status === "active" || plan.status === "trialing";
    if (runs) hideCardNeeded();
  }, [open, plan, read.dataUpdatedAt]);

  // The plan once it says a card is needed; until then, what the refusal that opened it said.
  const addCardUrl =
    plan && needsCard(plan) ? plan.addCardUrl : refusalAddCardUrl();
  const words = stoppedWords(plan, addCardUrl);
  return (
    <Dialog
      onOpenChange={(next) => (next ? showCardNeeded() : hideCardNeeded())}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{words.title}</DialogTitle>
          <DialogDescription>{words.said}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-1">
          {usedUp ? (
            // The same bar as the Plan row in Settings, full.
            <Progress className="gap-2" value={100}>
              <ProgressLabel>Free trial</ProgressLabel>
              <ProgressValue>{() => trialUsed(100)}</ProgressValue>
            </Progress>
          ) : null}
          <p className="text-foreground text-sm text-pretty">{words.next}</p>
        </DialogBody>
        {addCardUrl ? (
          <DialogFooter className="mt-1">
            <a className={cn(buttonVariants({ size: "sm" }))} href={addCardUrl}>
              {plan ? cardAction(plan) : "Add a card"}
            </a>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
