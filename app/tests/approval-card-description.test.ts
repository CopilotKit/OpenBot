import { expect, test } from "bun:test";
import { GALLERY } from "@/components/gallery/decisions";

/**
 * The Approval card is offered to every Bot that holds it, in these words, including a Bot on another
 * framework whose own tools never pass OpenBot's approval gate. Such a Bot told that "OpenBot asks
 * the person itself" before a delete or a send would skip its own card, and nobody would ask at all.
 * A Bot OpenBot runs is told OpenBot asks (`ASKING_GUIDANCE`), and a Bot somewhere else is told so
 * only for the apps and tools OpenBot gives it (`BROUGHT_BOT_ASKING_GUIDANCE`); see
 * server/tests/approvals-ask-once.
 */
const approval = GALLERY.find((component) => component.name === "askApproval");

test("the Approval card does not tell a Bot that OpenBot asks for it", () => {
  expect(approval?.description).toBeDefined();
  expect(approval?.description).not.toMatch(/OpenBot asks/i);
  expect(approval?.description).not.toMatch(/do not use it before/i);
});

test("the Approval card still says to ask before something that can't be undone", () => {
  expect(approval?.description).toMatch(/cannot undo/);
});
