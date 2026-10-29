import {
  IconCheck,
  IconChevronRight,
  IconCircleCheck,
  IconMail,
  IconShieldCheck,
  IconTerminal2,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import { Fragment, type ReactNode, useId } from "react";
import { Button } from "@/components/ui/button";
import {
  type ApprovalView,
  approvalOutcome,
  approvalPlace,
  clockTime,
  decisionReceipt,
  describeApproval,
  type OutcomeTone,
} from "@/lib/approval-view";
import type { ApprovalDecision, ApprovalRequest } from "@/lib/approvals";
import { cn } from "@/lib/utils";

const KIND_ICON = {
  mail: IconMail,
  browser: IconWorld,
  command: IconTerminal2,
  other: IconShieldCheck,
} as const;

const PILL_TONES: Record<OutcomeTone, string> = {
  done: "bg-status-done-soft text-status-done",
  working: "bg-status-working-soft text-status-working",
  needs: "bg-status-needs-soft text-status-needs",
  problem: "bg-status-problem-soft text-status-problem",
  neutral: "bg-muted text-muted-foreground",
};

/** Decline and Allow once: half the card wide each, a finger's height tall. */
const CHOICE =
  "h-(--target) min-w-0 flex-1 basis-28 rounded-full px-4 type-sub font-semibold";

/**
 * One action a Bot wants to take, and the person's answer to it: what it is, where, who it goes to
 * and what it says, then Decline and Allow once. "Always allow here" is a quiet button under the
 * two, because it saves a rule for this Bot, this action and this place rather than answering only
 * this request. A hand-off is the person's to do, so it asks "I did it myself" or "Don't do it".
 *
 * Once decided the card folds: the title, a pill saying how it ended (Allowed, Sent, Done,
 * Declined, Didn't work), and a line saying who decided and when. While it waits, everything the
 * request carries is one tap away under Details.
 *
 * `frame="card"` draws it as a card of its own, for a conversation. `frame="row"` leaves the frame
 * to the list it sits in, a row of a page's `PageRows` card.
 */
export function ApprovalCard({
  request,
  botName,
  busy = false,
  error,
  onDecide,
  frame = "card",
  className,
}: {
  request: ApprovalRequest;
  /** Named where the card is shown away from the Bot's own conversation. */
  botName?: string;
  busy?: boolean;
  error?: string | null;
  onDecide?: (choice: ApprovalDecision) => void;
  frame?: "card" | "row";
  className?: string;
}) {
  const view = describeApproval(request);
  const waiting = request.status === "pending";
  const handOff = request.action.policy?.behaviour === "hand_off";
  const outcome = approvalOutcome(request);
  const receipt = waiting ? null : decisionReceipt(request);
  const place = approvalPlace(request);
  const caption = [botName, view.app].filter(Boolean).join(" · ");
  const Icon = KIND_ICON[view.kind];

  return (
    <section
      // Named while it waits, so it is a region a screen reader can jump to; folded, it is not.
      aria-label={waiting ? "Waiting for your approval" : undefined}
      className={cn(
        "w-full min-w-0",
        frame === "card" &&
          "max-w-xl overflow-hidden rounded-xl bg-card text-card-foreground shadow-(--shadow-raised)",
        className,
      )}
    >
      <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
        >
          <Icon className="size-4" stroke={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="type-body font-semibold [overflow-wrap:anywhere]">
            {handOff && waiting ? `This needs you: ${view.title}` : view.title}
          </p>
          {caption || place ? (
            <p className="type-caption text-muted-foreground">
              {caption}
              {caption && place ? " · " : null}
              {/* Shown whole, however long: the person is deciding about this exact place. */}
              {place ? (
                <span className="[overflow-wrap:anywhere]">{place}</span>
              ) : null}
            </p>
          ) : null}
        </div>
        {outcome ? (
          <span
            className={cn(
              "type-caption inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 font-medium",
              PILL_TONES[outcome.tone],
            )}
          >
            {outcome.tone === "done" ? (
              <IconCheck aria-hidden className="size-3.5" stroke={2.6} />
            ) : null}
            {outcome.label}
          </span>
        ) : null}
      </div>
      {waiting ? (
        <ApprovalContent handOff={handOff} request={request} view={view} />
      ) : null}
      {error ? (
        <p className="type-caption px-4 pb-2 text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {waiting && onDecide ? (
        <div className={cn("px-4 pt-1 pb-3", frame === "row" && "max-w-md")}>
          <div className="flex flex-wrap gap-2">
            <Button
              className={cn(CHOICE, "bg-transparent dark:bg-transparent")}
              disabled={busy}
              onClick={() => onDecide("deny")}
              variant="outline"
            >
              {handOff ? "Don't do it" : "Decline"}
            </Button>
            <Button
              className={CHOICE}
              disabled={busy}
              onClick={() => onDecide(handOff ? "handled" : "allow_once")}
            >
              {handOff ? "I did it myself" : "Allow once"}
            </Button>
          </div>
          {handOff ? null : (
            <Button
              className="mx-auto mt-1 flex h-(--target) rounded-full px-3 type-sub text-muted-foreground hover:text-foreground"
              disabled={busy}
              onClick={() => onDecide("allow_always")}
              variant="ghost"
            >
              Always allow here
            </Button>
          )}
        </div>
      ) : null}
      {receipt ? (
        <DecidedLine
          at={request.decidedAt ?? null}
          declined={request.decision === "deny"}
        >
          {receipt}
        </DecidedLine>
      ) : null}
    </section>
  );
}

/** The fields, the body, why the Bot asked, and everything else it would send. */
function ApprovalContent({
  request,
  view,
  handOff,
}: {
  request: ApprovalRequest;
  view: ApprovalView;
  handOff: boolean;
}) {
  const detailsId = useId();
  return (
    <>
      {view.fields.map((field) => (
        <Fragment key={field.label}>
          <Hairline />
          <div className="flex min-h-11 items-baseline gap-3 px-4 py-2.5">
            <span className="type-caption min-w-16 max-w-[45%] shrink-0 font-medium text-muted-foreground">
              {field.label}
            </span>
            <span className="type-sub min-w-0 font-medium [overflow-wrap:anywhere]">
              {field.value}
            </span>
          </div>
        </Fragment>
      ))}
      {view.body ? (
        <>
          <Hairline />
          {/* Whole, not clipped: this is what the person is agreeing to send or type. */}
          <p className="type-sub whitespace-pre-wrap px-4 py-3 [overflow-wrap:anywhere]">
            {view.body}
          </p>
        </>
      ) : null}
      {request.action.policy?.reason ? (
        <p className="type-caption px-4 pt-2 text-muted-foreground">
          {handOff ? "Handed to you: " : ""}
          {request.action.policy.reason}
        </p>
      ) : null}
      <details className="group px-4">
        <summary
          aria-controls={detailsId}
          className="type-caption inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
        >
          Details
          <IconChevronRight
            aria-hidden
            className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none"
            stroke={2.2}
          />
        </summary>
        <pre
          className="mb-2 max-h-52 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 font-mono text-muted-foreground text-xs outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring"
          id={detailsId}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: A long request scrolls, and a keyboard needs focus to scroll it.
          tabIndex={0}
        >
          {JSON.stringify(request.action.args, null, 2)}
        </pre>
      </details>
    </>
  );
}

/** The line between a card's parts, short of its edges like the rows of a list. */
function Hairline() {
  return <div aria-hidden className="mx-4 h-px bg-border" />;
}

/** Who decided and when, under a decided card. */
function DecidedLine({
  children,
  at,
  declined,
}: {
  children: ReactNode;
  at: string | null;
  declined: boolean;
}) {
  const Mark = declined ? IconX : IconCircleCheck;
  return (
    <>
      <Hairline />
      <div className="flex min-h-12 items-center gap-2 px-4 py-2">
        <Mark
          aria-hidden
          className={cn(
            "size-5 shrink-0",
            declined ? "text-muted-foreground" : "text-status-done",
          )}
          stroke={2.2}
        />
        <span className="type-sub font-medium">{children}</span>
        {at ? (
          <time
            className="type-caption ml-auto shrink-0 text-muted-foreground"
            dateTime={at}
          >
            {clockTime(at)}
          </time>
        ) : null}
      </div>
    </>
  );
}
