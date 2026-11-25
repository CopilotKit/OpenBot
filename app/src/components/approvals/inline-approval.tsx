import { offersStandingRule } from "@openbot/shared/standing-rule";
import { approvalPhrase } from "@openbot/shared/tool-name";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useState } from "react";
import { ShareText, shareOf } from "@/components/approvals/share-details";
import { ToolLine } from "@/components/channels/tool-line";
import { DecisionCard } from "@/components/decisions/decision-card";
import type { Tone } from "@/components/gallery/frame";
import {
  SettingsChangeRows,
  settingsChangeOf,
} from "@/components/settings-tools/settings-change-card";
import { settingsApprovalBodyFor } from "@/components/settings-tools/settings-tool-card";
import {
  type ApprovalDecision,
  approvalInboxOptions,
  decideApproval,
} from "@/lib/approvals";
import { noteAnswered } from "@/lib/computers/activity";
import { failureSaid } from "@/lib/load-failure";
import { EASE_OUT } from "@/lib/motion";

/**
 * A pending approval, drawn in the conversation where the action it holds would have been.
 *
 * The same request as the Approvals page, read from the same owner-scoped inbox, so a decision made
 * in either place is the one decision. Once decided the server runs the action exactly once and
 * continues the conversation, and this gives the line back to the tool's own renderer.
 *
 * THE ANSWER STAYS IN THE CONVERSATION. Decided, the card folds into one line saying what the person
 * answered ("Allowed once: Click Submit"), which opens to the card as it was answered, as a Bot's
 * work folds (`ToolLine`). It used to fold away altogether, so scrolling back, or opening the
 * conversation again, nothing said a Bot had asked or what the person said; only Activity did.
 */
/** What each answer does, as the row under it says it. */
const CHOICE_WORDS: Record<
  ApprovalDecision,
  { label: string; description: string; done: string; tone: Tone }
> = {
  allow_once: {
    label: "Allow once",
    description: "The Bot does it this time. You're asked again next time.",
    done: "Allowed once",
    tone: "positive",
  },
  allow_conversation: {
    label: "Allow for this conversation",
    description:
      "The Bot does it now, and again in this conversation without asking.",
    done: "Allowed for this conversation",
    tone: "positive",
  },
  allow_always: {
    label: "Always allow here",
    description: "The Bot does it now, and here without asking from now on.",
    done: "Always allowed",
    tone: "positive",
  },
  deny: {
    label: "Deny",
    description: "The Bot doesn't do it, and is told you said no.",
    done: "Denied",
    tone: "negative",
  },
  handled: {
    label: "I did it myself",
    description: "You've done it, so the Bot carries on from there.",
    done: "Done by you",
    tone: "positive",
  },
};

export function InlineApproval({
  toolCallId,
  fallback,
}: {
  toolCallId?: string;
  fallback: ReactNode;
}) {
  const cache = useQueryClient();
  const inbox = useQuery(approvalInboxOptions());
  const reduceMotion = useReducedMotion();
  /*
   * The answer given here: the card folds into it at once, and then, when the inbox says the request
   * is no longer pending, folds away and gives the line back to the tool's own renderer, which says
   * what came of it.
   */
  const [answered, setAnswered] = useState<ApprovalDecision | null>(null);
  const decision = useMutation({
    mutationFn: (choice: ApprovalDecision) =>
      decideApproval(request?.id ?? "", choice),
    onSuccess: (_, choice) => {
      setAnswered(choice);
      // Answered here, so the step's entry in Activity says when, even on a page opened after it was asked.
      if (toolCallId) noteAnswered(toolCallId);
      return cache.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
  const request = toolCallId
    ? inbox.data?.requests.find(
        (candidate) => candidate.action.toolCallId === toolCallId,
      )
    : undefined;
  const pending = request?.status === "pending";
  const handOff = request?.action.policy?.behaviour === "hand_off";
  const choices: ApprovalDecision[] = !request
    ? []
    : handOff
      ? ["handled", "deny"]
      : [
          "allow_once",
          ...(offersStandingRule(request.action)
            ? (["allow_conversation", "allow_always"] as ApprovalDecision[])
            : []),
          "deny",
        ];
  // In the words the step and Activity use for the same action: "Save a file todo.txt in share".
  const title = request ? approvalPhrase(request.action) : "";
  // A share shows who reads it and what it would send, so the person sees what leaves the conversation.
  const share = request ? shareOf(request.action) : null;
  // A change to OpenBot's settings shows its before, after and who it reaches while it waits.
  const change = settingsChangeOf(
    (request?.action.target as { change?: unknown } | undefined)?.change,
  );
  // A settings tool may draw its own body for the change; the shared rows otherwise.
  const ownBody = request
    ? settingsApprovalBodyFor(request.action.toolRef)
    : null;
  const heading = title.charAt(0).toUpperCase() + title.slice(1);
  const caption = request
    ? (request.action.policy?.reason ??
      share?.caption ??
      (handOff ? "This one is yours to do." : undefined))
    : undefined;
  // What the person answered, once the inbox no longer has it waiting; a rule's own answer has none.
  const said =
    request && !pending && request.decision
      ? CHOICE_WORDS[request.decision]
      : undefined;
  return (
    <>
      {/* The card leaves by folding away; what is left behind is the answer's line and the tool's own. */}
      <AnimatePresence initial={false}>
        {pending && request ? (
          <motion.section
            aria-label="Waiting for your approval"
            exit={{ height: 0, opacity: 0 }}
            key="approval"
            style={{ overflow: "hidden" }}
            transition={{
              duration: reduceMotion ? 0 : 0.22,
              ease: EASE_OUT,
            }}
          >
            <DecisionCard
              answer={
                answered
                  ? {
                      label: CHOICE_WORDS[answered].done,
                      tone: CHOICE_WORDS[answered].tone,
                    }
                  : undefined
              }
              caption={caption}
              error={decision.error}
              onSubmit={(value) => decision.mutate(value as ApprovalDecision)}
              options={choices.map((choice) => ({
                value: choice,
                label:
                  handOff && choice === "deny"
                    ? "Don't do it"
                    : CHOICE_WORDS[choice].label,
                description: CHOICE_WORDS[choice].description,
              }))}
              submitting={decision.isPending}
              title={heading}
            >
              {change && ownBody ? (
                <ownBody.Body
                  args={
                    (request.action.args as Record<string, unknown> | null) ??
                    {}
                  }
                  change={change}
                  tool={ownBody.tool}
                />
              ) : change ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm">{change.summary}</p>
                  <SettingsChangeRows change={change} state="waiting" />
                </div>
              ) : share?.text || share?.files.length ? (
                <ShareText files={share.files} text={share.text} />
              ) : null}
            </DecisionCard>
          </motion.section>
        ) : null}
      </AnimatePresence>
      {said && request ? (
        <ToolLine
          bare
          detail={heading}
          label={`${said.done}:`}
          openKey={`approval:${request.id}`}
        >
          {/* The card as it was answered: what was asked, why, and the answer in place of the choices. */}
          <DecisionCard
            answer={{ label: said.done, tone: said.tone }}
            caption={caption}
            onSubmit={() => {}}
            options={[]}
            title={heading}
          />
        </ToolLine>
      ) : null}
      {pending ? null : fallback}
      {/*
        The conversation could not be carried on after this was decided, so the step above never got
        its result and would say "Send message…" for good. What came of it is said here, from the
        request itself, which is the one place that still knows.
      */}
      {request?.left ? (
        <p
          className={
            request.left.done
              ? "mt-1 text-muted-foreground text-sm"
              : "mt-1 text-destructive text-sm"
          }
          data-testid="approval-left"
          role={request.left.done ? "status" : "alert"}
        >
          {failureSaid(request.left)}
        </p>
      ) : null}
    </>
  );
}

/**
 * Every approval a conversation is waiting on, for a surface drawn over that conversation: the
 * Computer or the Bot's profile in a sheet on a narrow window covers the cards in the transcript, so
 * the sheet draws them too. The same card, from the same inbox, so answering either answers both.
 */
export function ConversationApprovals({ threadId }: { threadId: string }) {
  const inbox = useQuery(approvalInboxOptions());
  const ids = (inbox.data?.requests ?? []).flatMap((request) =>
    request.status === "pending" &&
    request.action.threadId === threadId &&
    request.action.toolCallId
      ? [request.action.toolCallId]
      : [],
  );
  if (ids.length === 0) return null;
  return (
    <div className="space-y-2">
      {ids.map((id) => (
        <InlineApproval key={id} toolCallId={id} fallback={null} />
      ))}
    </div>
  );
}

/**
 * The pending approvals for a group of tool calls, for a transcript that draws those calls itself
 * rather than through each tool's renderer: the browser-activity group folds every click and field
 * into one collapsed line, so a card inside a step would never be seen. Drawn beside the group,
 * outside the fold, one card per waiting call and one line per answered one; nothing at all when
 * none was asked about.
 */
export function PendingApprovals({
  toolCallIds,
}: {
  toolCallIds: readonly string[];
}) {
  const inbox = useQuery(approvalInboxOptions());
  /*
   * And one already decided: the person's answer is said beside the group as its own line, since the
   * folded line ("Used Slack") says nothing of what they were asked or what they said. One whose
   * conversation could not be carried on after it was decided (`left`) says what came of it too.
   */
  const asked = (inbox.data?.requests ?? []).filter(
    (request) =>
      request.action.toolCallId &&
      (request.status === "pending" || request.decision || request.left),
  );
  const ids = toolCallIds.filter((id) =>
    asked.some((request) => request.action.toolCallId === id),
  );
  if (ids.length === 0) return null;
  // Answers alone sit under the group as its next lines; a card waiting stands apart from it.
  const cards = asked.some(
    (request) =>
      ids.includes(request.action.toolCallId ?? "") &&
      (request.status === "pending" || request.left),
  );
  return (
    <div className={cards ? "mt-2 space-y-2" : undefined}>
      {ids.map((id) => (
        <InlineApproval key={id} toolCallId={id} fallback={null} />
      ))}
    </div>
  );
}
