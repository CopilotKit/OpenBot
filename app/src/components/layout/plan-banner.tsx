import { buttonVariants } from "@/components/ui/button";
import { needsCard, usePlan } from "@/lib/plan/queries";
import { blockedNotice, cardAction, trialLeft } from "@/lib/plan/words";
import { cn } from "@/lib/utils";

/**
 * A slim bar over every page while the organization's plan is something its people need to know:
 * how long its free trial has left, or that Bots can't run until a card is added or updated.
 *
 * Only where this OpenBot needs a plan (`required`); a self-hosted OpenBot and OpenBot Desktop draw
 * nothing. An owner or an admin is given the way to add the card (`addCardUrl`, the server's verdict
 * on who may), a member is told who to ask. Nothing while the plan is read, or when it couldn't be.
 *
 * The same bar as the update and self-host ones, so it reads as OpenBot's own, packed from the left.
 * The card is added on another page, so the button is a link that leaves the app: the person comes
 * back signed in, with the trial started.
 */
export function PlanBanner() {
  const plan = usePlan();
  if (!plan?.required) return null;

  if (plan.status === "trialing" && plan.trialEndsAt) {
    return (
      <aside
        aria-label="Plan"
        className="flex h-10 shrink-0 items-center border-b border-border bg-muted/60 px-4 text-sm"
      >
        <p className="min-w-0 truncate text-foreground" role="status">
          {trialLeft(plan.trialEndsAt)}
        </p>
      </aside>
    );
  }

  if (!needsCard(plan)) return null;
  const said = blockedNotice(plan);
  return (
    <aside
      aria-label="Plan"
      className="flex shrink-0 flex-wrap items-center gap-x-2 border-b border-border bg-muted/60 px-4 py-1.5 text-sm"
    >
      <p className="text-foreground" role="status">
        {said}
      </p>
      {plan.addCardUrl ? (
        <a
          // Foreground, not the link variant's primary, which is a mid grey on the dark bar.
          className={cn(
            buttonVariants({ size: "sm", variant: "link" }),
            "px-0 text-foreground underline",
          )}
          href={plan.addCardUrl}
        >
          {cardAction(plan)}
        </a>
      ) : null}
    </aside>
  );
}
