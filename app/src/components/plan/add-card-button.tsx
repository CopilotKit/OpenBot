import { buttonVariants } from "@/components/ui/button";
import { needsCard, usePlan } from "@/lib/plan/queries";
import { cardAction } from "@/lib/plan/words";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/**
 * Add a card, beside a refusal that says Bots can't run without one: where the person already is
 * when they find out. Only while the organization needs a card and only for somebody who may add
 * it (`addCardUrl`, the server's verdict); a member reads the refusal, which tells them who to ask.
 *
 * A link, since the card is added on another page and the person comes back signed in. The plan is
 * read again when this appears, so a refusal that found the trial over is not drawn against an
 * answer from before it ended. Named query client, as everything drawn inside a conversation.
 */
export function AddCardButton() {
  const plan = usePlan({ fresh: true, client: queryClient });
  if (!plan || !needsCard(plan) || !plan.addCardUrl) return null;
  return (
    <a
      className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
      href={plan.addCardUrl}
    >
      {cardAction(plan)}
    </a>
  );
}
