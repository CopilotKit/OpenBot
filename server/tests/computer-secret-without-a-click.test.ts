import { describe, expect, test } from "bun:test";
import { computerGuidance } from "@openbot/shared/bot-prompt";
import { SECRET_FIELD_BY_REF } from "@openbot/shared/computer-control";
import { safetyRequirement } from "../src/approvals/policy";
import type { ApprovalCandidate } from "../src/approvals/types";
import { botSeat } from "../src/computer/computer-key";
import type { ComputerGateway } from "../src/computer/gateway";
import { createHeadlessComputerTools } from "../src/computer/headless-tools";

/**
 * A PASSWORD THE PERSON GIVES THROUGH THE MASKED BOX, WITHOUT A HAND-OVER.
 *
 * A Bot that needs one value it must not be told asks for it with `computer_request_secret`, and the
 * person types it into a masked box that puts it straight into the field. The Bot was told to click
 * the field first, and a Bot's click on a password field is a credential typed on a website, which
 * the gate hands to the person (`safetyRequirement`). Doing as it was told, a Bot handed the whole
 * browser over on the click and the masked box was never reached. The rule is right: a Bot's own
 * click or typing there is the person's to do. So the words changed: the field is named by its ref,
 * which the computer fills itself, and nothing tells a Bot to click it first.
 */

/** A Bot's click on the members' page's password field, as the gate sees it. */
const clickPassword: ApprovalCandidate = {
  actorId: "owner",
  botId: "keeper",
  toolRef: "computer_click",
  effect: "write",
  scope: "host.docker.internal",
  args: { ref: "e14", snapshotId: 2 },
  target: {
    pageUrl: "http://host.docker.internal:46600/members",
    element: { ref: "e14", role: "textbox", name: "Password" },
  },
};

/** What every Bot with a computer is told about it, as built-in and brought Bots alike are told. */
const prompt = computerGuidance({ search: false, personal: true });

/** The server's own `computer_request_secret`, for a turn no browser runs. */
const serverTool = createHeadlessComputerTools({
  gateway: {} as ComputerGateway,
  seat: botSeat("keeper"),
  actor: { id: "owner", userId: "owner" },
}).find((tool) => tool.definition.name === "computer_request_secret");

/** What tells a Bot to click or focus the field before asking. */
const CLICK_FIRST = /(click|focus)(es)? the field first(?!:)|focused field/i;

describe("a secret goes into its field by its ref, with no click the gate hands over", () => {
  test("a Bot's own click on a password field is still the person's to do", () => {
    expect(safetyRequirement(clickPassword)).toMatchObject({
      id: "credentials",
      behaviour: "hand_off",
    });
  });

  test("the standing instructions ask for a secret by the field's ref, and never to click it first", () => {
    const said = prompt.replace(/\s+/g, " ");
    expect(said).toContain(
      "Call computer_request_secret with that field's ref and a short label, without clicking the field first",
    );
    expect(said).not.toMatch(/Click the field first, then call/);
  });

  test("the server's tool says it in the sentence the browser's tool is built from", () => {
    const description = serverTool?.definition.description ?? "";
    expect(description).toContain(SECRET_FIELD_BY_REF);
    expect(description).not.toMatch(CLICK_FIRST);
    expect(SECRET_FIELD_BY_REF).toContain(
      "Do not click or type into the field first",
    );
  });
});
