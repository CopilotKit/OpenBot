import type { Locator, Page } from "@playwright/test";
import { expect } from "../harness/test";
import { runsSoFar, transcript } from "./computer-steps";

/**
 * What the approval journeys share: the card a Bot's payment waits on, answering it, and the banner
 * that lists what a conversation allows.
 *
 * Paying is one of the actions that always asks (server/src/approvals/policy.ts), and a checkout's
 * Place order button is how a Bot pays on a website. The shop is the run's own (`e2e/site`), and it
 * counts the orders actually placed, so an answer is checked by what happened as well as by what
 * the Bot said. After an answer the server carries the action out and continues the conversation
 * itself; the reply it streams is checked word for word on screen, once, because a reply after an
 * approval once arrived garbled.
 */

/** Why a payment asks, as its card says. */
export const PAYS = "Paying, buying or moving money asks you first.";

/** Every answer a payment's card offers, in order. */
export const CHOICES = [
  "Allow once",
  "Allow for this conversation",
  "Always allow here",
  "Deny",
] as const;
/** The answers a step handed to the person offers: they do it, or nobody does. */
export const HANDED_OVER = ["I did it myself", "Don't do it"] as const;
export type Choice = (typeof CHOICES)[number] | (typeof HANDED_OVER)[number];

/** The approval card in the conversation, while it waits on the person. */
export function approvalCard(page: Page): Locator {
  return transcript(page).getByRole("region", {
    name: "Waiting for your approval",
  });
}

/** The card for a payment on Place order, waiting, with every answer on it. */
export async function expectAsksToPay(page: Page) {
  const card = approvalCard(page);
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card).toContainText(PAYS);
  await expect(card).toContainText("Place order");
  await expect(card.getByText("Waiting on you")).toBeVisible();
  for (const choice of CHOICES) {
    await expect(card.getByRole("radio", { name: choice })).toBeVisible();
  }
}

/**
 * Pick an answer on the card and send it with the button, which is named for the answer picked.
 * Returns the mark (`runsSoFar`) the reply that follows is waited for from.
 */
export async function answer(
  page: Page,
  channelId: string,
  choice: Choice,
): Promise<number> {
  const card = approvalCard(page);
  const mark = await runsSoFar(page, channelId);
  // The radio is visually hidden inside its row; a person picks the row.
  const radio = card.getByRole("radio", { name: choice });
  await card
    .locator("label")
    .filter({ has: page.getByRole("radio", { name: choice }) })
    .click({ timeout: 30_000 });
  await expect(radio).toBeChecked();
  await card.getByRole("button", { name: choice }).click({ timeout: 30_000 });
  await expect(approvalCard(page)).toHaveCount(0, { timeout: 60_000 });
  return mark;
}

/** The banner above the composer that lists what this conversation allows. */
export function allowances(page: Page): Locator {
  return page.getByRole("region", { name: "Allowed in this conversation" });
}
