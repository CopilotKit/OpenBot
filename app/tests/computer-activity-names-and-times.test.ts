import { expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  DECLINED_BY_PERSON,
  HANDLED_BY_PERSON,
} from "@openbot/shared/approval-outcomes";
import { withFinishedAt } from "@openbot/shared/computer-control";
import {
  activityFor,
  conversationActivity,
  noteAnswered,
  recordActivity,
} from "../src/lib/computers/activity";

/**
 * What Activity says about a step that went through an approval, as the end-to-end journeys found it.
 *
 * A click the person declined, or one handed to them that they did themselves, came back as a sentence
 * rather than the computer's answer, so nothing named the button and the row showed the Bot's ref:
 * "Declined f2e13", "Clicked on page e14". And the steps the server took after the person answered
 * never passed through the browser, so their rows had no time beside them. The conversations here are
 * the ones those journeys made: a checkout's Place order denied, a sign-in's password handed over.
 */

let computers = 0;
function computer(): string {
  computers += 1;
  return `names-and-times-${computers}`;
}

/** One assistant message with one call, and its answer. */
function step(
  id: string,
  name: string,
  args: Record<string, unknown>,
  answer: string | Record<string, unknown>,
): Message[] {
  return [
    {
      id: `assistant-${id}`,
      role: "assistant",
      toolCalls: [
        {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    {
      id: `tool-${id}`,
      role: "tool",
      toolCallId: id,
      content: typeof answer === "string" ? answer : JSON.stringify(answer),
    },
  ];
}

/** The checkout's snapshot, as the computer answered it: the Place order button is `f2e13` in snapshot 4. */
const checkout = step(
  "snapshot",
  "computer_snapshot",
  {},
  {
    ok: true,
    snapshotId: 4,
    url: "http://host.docker.internal:46600/shop/basil",
    title: "Checkout: Genovese basil seeds",
    truncated: false,
    elements: [
      { ref: "f2e5", role: "link", name: "Home" },
      { ref: "f2e13", role: "button", name: "Place order" },
    ],
  },
);

/** The members' sign-in, where the password field is `e14` in snapshot 2. */
const signIn = step(
  "members-snapshot",
  "computer_snapshot",
  {},
  {
    ok: true,
    snapshotId: 2,
    url: "http://host.docker.internal:46600/members",
    title: "Members sign in",
    truncated: false,
    elements: [
      { ref: "e12", role: "textbox", name: "Username" },
      { ref: "e14", role: "textbox", name: "Password" },
    ],
  },
);

function didOf(messages: Message[], id: string) {
  return conversationActivity(messages).find((call) => call.id === id)?.did;
}

test("a declined click names the button it would have pressed, as a click that ran does", () => {
  const declined = didOf(
    [
      ...checkout,
      ...step(
        "place-order",
        "computer_click",
        { ref: "f2e13", snapshotId: 4 },
        DECLINED_BY_PERSON,
      ),
    ],
    "place-order",
  );
  expect(declined).toMatchObject({
    step: "computer_click",
    subject: "Place order",
    declined: true,
    output: "You declined it.",
  });
});

test("a click handed to the person and done by them names the field", () => {
  const handed = didOf(
    [
      ...signIn,
      ...step(
        "password",
        "computer_click",
        { ref: "e14", snapshotId: 2 },
        HANDLED_BY_PERSON,
      ),
    ],
    "password",
  );
  expect(handed).toMatchObject({
    step: "computer_click",
    subject: "Password",
    doneByPerson: true,
  });
});

test("the label comes from the snapshot the ref came from, and the ref only when none names it", () => {
  // Snapshot 4 has no e14: a ref from another snapshot is not named after whatever holds it here.
  const elsewhere = didOf(
    [
      ...checkout,
      ...step(
        "stale",
        "computer_click",
        { ref: "e14", snapshotId: 4 },
        DECLINED_BY_PERSON,
      ),
    ],
    "stale",
  );
  expect(elsewhere?.subject).toBe("e14");
  // The computer's own name for what it clicked still wins.
  const ran = didOf(
    [
      ...checkout,
      ...step(
        "ran",
        "computer_click",
        { ref: "f2e13", snapshotId: 4 },
        {
          ok: true,
          action: "click",
          element: { role: "button", name: "Place order now" },
          url: "http://host.docker.internal:46600/shop/basil",
          elapsedMs: 40,
        },
      ),
    ],
    "ran",
  );
  expect(ran?.subject).toBe("Place order now");
});

test("a step the server took after an approval has the time it finished, after a reload too", () => {
  const id = computer();
  const finishedAt = "2026-11-12T22:05:35.000Z";
  // The page never ran it: the server did, after the person allowed the order, and said when.
  recordActivity(
    id,
    conversationActivity(
      step(
        "read-after-approval",
        "computer_read",
        {},
        {
          ok: true,
          url: "http://host.docker.internal:46600/shop/tomato",
          title: "Order confirmed",
          text: "Your order FH-2041 is placed.",
          finishedAt,
        },
      ),
    ),
  );
  expect(activityFor(id)).toEqual([
    expect.objectContaining({
      id: "read-after-approval",
      at: Date.parse(finishedAt),
    }),
  ]);
});

test("a step the person answered here is timed by their answer, not by when its answer arrived", () => {
  const id = computer();
  const realNow = Date.now;
  try {
    // "I did it myself" on the password, at 1 s.
    Date.now = () => 1_000;
    noteAnswered("password-answered");
    // Its answer reaches the page at 9 s, once the turn the server carried on with is over.
    Date.now = () => 9_000;
    recordActivity(
      id,
      conversationActivity([
        ...signIn,
        ...step(
          "password-answered",
          "computer_click",
          { ref: "e14", snapshotId: 2 },
          HANDLED_BY_PERSON,
        ),
      ]),
    );
  } finally {
    Date.now = realNow;
  }
  expect(
    activityFor(id).find((entry) => entry.id === "password-answered")?.at,
  ).toBe(1_000);
});

test("an answer that does not say when, from before answers did, still says nothing about when", () => {
  const id = computer();
  recordActivity(
    id,
    conversationActivity(
      step(
        "opened-before",
        "computer_navigate",
        { url: "http://host.docker.internal:46600/" },
        {
          ok: true,
          url: "http://host.docker.internal:46600/",
          title: "Fernhill Garden Supply",
        },
      ),
    ),
  );
  const entries = activityFor(id);
  expect(entries).toHaveLength(1);
  expect(Object.hasOwn(entries[0] as object, "at")).toBe(false);
});

test("a step's answer is stamped with when it finished, once, and a step waiting on a person is not", () => {
  const before = Date.now();
  const stamped = withFinishedAt({
    ok: true,
    url: "http://host.docker.internal:46600/",
  }) as {
    finishedAt: string;
  };
  expect(Date.parse(stamped.finishedAt)).toBeGreaterThanOrEqual(before);
  // Stamped already, by the server: kept as it said.
  const kept = { ok: true, finishedAt: "2026-11-12T22:05:35.000Z" };
  expect(withFinishedAt(kept)).toBe(kept);
  // The placeholder a step waiting on a person leaves is no answer, and has no time.
  const waiting = { waiting: true };
  expect(withFinishedAt(waiting)).toBe(waiting);
  // A sentence (declined, done by the person) is not an object to stamp.
  expect(withFinishedAt(DECLINED_BY_PERSON)).toBe(DECLINED_BY_PERSON);
});
