import { employeeTrialUsedUp, type PlanStatus, trialUsedUp } from "./queries";

/** The date in the person's own words: "20 Dec 2026". */
function onDate(at: string): string {
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** What OpenBot costs once the free trial is used up, as every screen says it. */
export const PRICE = "$5 a month for each member of this organization";

/**
 * Said to a CopilotKit employee once their free trial is used up, in place of the way to pay: their
 * runs are free. Kept word for word as it was asked for.
 */
export const COPILOTKIT_EMPLOYEE_LINE =
  "Free because you're a CopilotKit employee. Thanks, Uncle Atai!";

/**
 * On the Plan row, for a CopilotKit employee who is an admin of an organization whose other members
 * need a card: their own runs are free, everyone else's aren't.
 */
export const OTHERS_NEED_A_CARD =
  "Everyone else in this organization needs a card added to keep their Bots running. It's $5 a month for each member.";

/** Under the photo of Sentry that follows that line, word for word as it was asked for. */
export const SENTRY_LINE = "Sentry loves you too.";

/** What the photo shows, for a screen reader and for anyone whose browser doesn't draw it. */
export const SENTRY_ALT =
  "Sentry, a white golden retriever, sitting on a rock above a mountain meadow";

/** The button that takes an admin to add or update the card. */
export function cardAction(plan: PlanStatus): string {
  return plan.status === "past_due" ? "Update card" : "Add a card";
}

/**
 * The notice over every page while Bots can't run, in the words its reader can act on: an admin is
 * told what to do, a member who to ask.
 */
export function blockedNotice(plan: PlanStatus): string {
  const admin = plan.addCardUrl !== null;
  if (plan.status === "past_due")
    return admin
      ? "Your last payment didn't go through, so Bots can't run. Update your card to carry on."
      : "Bots can't run until an admin updates this organization's card.";
  /*
   * As the server begins its refusal of a run, so the bar, the refused turn and the dialog say the
   * same thing. The price is the dialog's to say (`PRICE`): here it would take the bar onto a
   * second line over every page.
   */
  return admin
    ? "You've used your free trial. Add a card to keep your Bots running."
    : "You've used your free trial. Ask an admin to add a card to keep your Bots running.";
}

/** "42% used": how much of the free trial is gone, never the count or the cap. */
export function trialUsed(percent: number): string {
  return `${Math.min(100, Math.max(0, Math.round(percent)))}% used`;
}

/** What the Plan row on the organization's settings says about where it stands. */
export function planSummary(plan: PlanStatus): string {
  switch (plan.status) {
    case "free":
    case "trialing":
      return "Free trial";
    case "active":
      return plan.renewsAt
        ? `Active, renews ${onDate(plan.renewsAt)}`
        : "Active";
    case "past_due":
      return "Last payment failed";
    case "none":
      return trialUsedUp(plan) ? "Free trial used up" : "No plan yet";
    default:
      return "Couldn't check the plan just now";
  }
}

/** What the dialog that stops an AI action says, for the plan that stopped it. */
export type StoppedWords = {
  title: string;
  /** What happened, and what it costs from here. */
  said: string;
  /** What the reader does next: add the card, or ask who can. */
  next: string;
};

/**
 * The dialog's words. Once the free trial is used up it names the allowance the server sent
 * (`freeRunsAllowance`, never sent before then), says what OpenBot costs from here, and tells an
 * admin to add a card and a member who to ask. A failed payment says so instead.
 */
export function stoppedWords(
  plan: PlanStatus | undefined,
  /** Where the reader adds a card: only an owner or an admin is sent one. */
  addCardUrl: string | null | undefined = plan?.addCardUrl,
): StoppedWords {
  const admin = Boolean(addCardUrl);
  if (plan?.status === "past_due")
    return {
      title: "Your last payment didn't go through",
      said: "Bots can't run until this organization's card is updated.",
      next: admin
        ? "Update the card to keep your Bots running."
        : "Ask an admin of this organization to update the card.",
    };
  const allowance = plan?.freeRunsAllowance;
  // The title as the bar and the server's refusal begin, so the three read as one.
  return {
    title: "You've used your free trial",
    said: `${
      typeof allowance === "number"
        ? `Your free trial was ${allowance.toLocaleString()} Bot runs, and they're all used.`
        : "All the Bot runs in your free trial are used."
    } From now on, OpenBot is ${PRICE}.`,
    // The same words as everyone's, but a CopilotKit employee never pays: no card, nobody to ask.
    next: employeeTrialUsedUp(plan)
      ? COPILOTKIT_EMPLOYEE_LINE
      : admin
        ? "Add a card to keep your Bots running."
        : "Ask an admin of this organization to add a card.",
  };
}
