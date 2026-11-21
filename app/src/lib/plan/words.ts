import type { PlanStatus } from "./queries";

const DAY = 24 * 60 * 60 * 1000;

/** Whole days left before `end`, counting a part day as one; never below zero. */
export function daysLeft(end: string, now: Date = new Date()): number {
  const left = new Date(end).getTime() - now.getTime();
  if (!Number.isFinite(left) || left <= 0) return 0;
  return Math.ceil(left / DAY);
}

/** "Free trial, 23 days left", "Free trial, 1 day left", "Free trial ends today". */
export function trialLeft(end: string, now: Date = new Date()): string {
  const days = daysLeft(end, now);
  if (days === 0) return "Free trial ends today";
  return `Free trial, ${days} ${days === 1 ? "day" : "days"} left`;
}

/** The date in the person's own words: "20 Dec 2026". */
function onDate(at: string): string {
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

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
  return admin
    ? "Add a card to start your 30-day free trial. Bots can't run until you do."
    : "Bots can't run until an admin adds a card to this organization.";
}

/** What the Plan row on the organization's settings says about where it stands. */
export function planSummary(plan: PlanStatus, now: Date = new Date()): string {
  switch (plan.status) {
    case "trialing":
      return plan.trialEndsAt ? trialLeft(plan.trialEndsAt, now) : "Free trial";
    case "active":
      return plan.renewsAt
        ? `Active, renews ${onDate(plan.renewsAt)}`
        : "Active";
    case "past_due":
      return "Last payment failed";
    case "none":
      return "No plan yet";
    default:
      return "Couldn't check the plan just now";
  }
}
