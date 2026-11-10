import { describe, expect, test } from "bun:test";
import type { AuditEvent } from "../src/audit";
import {
  checkGrantActions,
  grantSetWarning,
  readerPrompt,
  replayGrantChange,
  writerPrompt,
} from "../src/plugins/grant-translate";
import { gmailApp } from "./support/gmail-grant-app";

/**
 * The two rules a set of actions chosen from a description is held to, on Composio's own Gmail
 * listing: the check that every action named is one Gmail offers, and the replay over a Bot's own app
 * calls. The rows replayed have the shape `callTool` writes (plugin-store/calls.ts), and
 * `app-grants-describe.integration.test.ts` replays rows the real store wrote.
 */

const app = gmailApp();
const ref = (name: string) => `composio-gmail/${name}`;
const BOT = "agent_inbox";

describe("the check", () => {
  test("names Gmail offers check, and a name given twice counts once", () => {
    const { check, refs } = checkGrantActions(
      ["GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_FETCH_EMAILS"],
      app,
    );
    expect(check).toEqual({ ok: true });
    expect(refs).toEqual([
      ref("GMAIL_FETCH_EMAILS"),
      ref("GMAIL_CREATE_EMAIL_DRAFT"),
    ]);
  });

  test("no actions at all checks: it is the set where the Bot can't use the app", () => {
    expect(checkGrantActions([], app)).toEqual({
      check: { ok: true },
      refs: [],
    });
  });

  test.each([
    [
      "an action Gmail doesn't have",
      "GMAIL_ARCHIVE_THREAD",
      '"GMAIL_ARCHIVE_THREAD" isn\'t an action Gmail offers. Closest:',
    ],
    [
      "the right action in the wrong case",
      "gmail_send_email",
      '"gmail_send_email" isn\'t an action Gmail offers. Closest: GMAIL_SEND_EMAIL.',
    ],
    [
      "an action written as its ref",
      "composio-gmail/GMAIL_SEND_EMAIL",
      '"composio-gmail/GMAIL_SEND_EMAIL" names the app too. Name the action alone: GMAIL_SEND_EMAIL.',
    ],
    [
      "another app's action",
      "SLACK_SEND_MESSAGE",
      '"SLACK_SEND_MESSAGE" isn\'t an action Gmail offers.',
    ],
    ["an empty name", "  ", "An action name is empty."],
  ])("%s is refused, and the error says why", (_name, action, words) => {
    const { check, refs } = checkGrantActions(
      ["GMAIL_FETCH_EMAILS", action],
      app,
    );
    expect(check.ok).toBe(false);
    const problems = (
      check as { problems: { action: string; message: string }[] }
    ).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]?.action).toBe(action);
    expect(problems[0]?.message).toStartWith(words);
    // The one that is real still resolves, so the screen can say which were wrong.
    expect(refs).toEqual([ref("GMAIL_FETCH_EMAILS")]);
  });

  test("the closest names a retry is pointed at share words with the wrong one", () => {
    const { check } = checkGrantActions(["GMAIL_ARCHIVE_THREAD"], app);
    const message = (check as { error: string }).error;
    const closest = message
      .slice(message.indexOf("Closest: ") + 9, -1)
      .split(", ");
    expect(closest.length).toBeGreaterThan(0);
    for (const name of closest) expect(name).toMatch(/^GMAIL_.*THREAD/);
  });

  test("a set that destroys things, or gives nothing, is called out; anything else is not", () => {
    expect(
      grantSetWarning(app, [
        ref("GMAIL_FETCH_EMAILS"),
        ref("GMAIL_DELETE_MESSAGE"),
        ref("GMAIL_SEND_DRAFT"),
      ]),
    ).toBe(
      "This lets the Bot take 2 actions that destroy things: GMAIL_DELETE_MESSAGE, GMAIL_SEND_DRAFT.",
    );
    expect(grantSetWarning(app, [], ["Salesforce"])).toBe(
      "This gives the Bot no Gmail actions at all. The description names Salesforce, which is set on its own page.",
    );
    // Two apps once read "names Slack, Salesforce, which is set on its own page".
    expect(grantSetWarning(app, [], ["Slack", "Salesforce"])).toBe(
      "This gives the Bot no Gmail actions at all. The description names Slack and Salesforce, which are each set on their own page.",
    );
    expect(grantSetWarning(app, [])).toBe(
      "This gives the Bot no Gmail actions at all.",
    );
    expect(
      grantSetWarning(app, [
        ref("GMAIL_FETCH_EMAILS"),
        ref("GMAIL_CREATE_EMAIL_DRAFT"),
      ]),
    ).toBeNull();
  });

  test("the reader is given the set and never the words, and the writer the whole list with its flags", () => {
    const writer = writerPrompt("Reads Gmail, never sends", app);
    expect(writer).toContain("Reads Gmail, never sends");
    expect(writer).toContain("- GMAIL_SEND_DRAFT [write, destroys]");
    expect(writer).toContain(`THE ACTIONS GMAIL OFFERS (${app.tools.length})`);
    const reader = readerPrompt(app, [ref("GMAIL_FETCH_EMAILS")], []);
    expect(reader).not.toContain("never sends");
    expect(reader).toContain(`ACTIONS IT GETS (1 of ${app.tools.length})`);
    expect(reader).not.toContain("OTHER APPS");
  });
});

let sequence = 0;
/** A row as `callTool` writes it: target the ref, payload the facts it was decided on. */
function callRow(
  eventType: string,
  name: string,
  options: {
    bot?: string;
    attempt?: string;
    refusal?: string;
    app?: string;
    at?: string;
  } = {},
): AuditEvent {
  sequence += 1;
  const server = options.app ?? "composio-gmail";
  const notGranted = options.refusal === "not_granted";
  return {
    id: `row-${sequence}`,
    actorUserId: null,
    initiatorKind: "person",
    initiatorId: null,
    eventType,
    targetType: "mcp_tool",
    targetId: `${server}/${name}`,
    createdAt: options.at ?? `2026-11-0${1 + (sequence % 8)}T10:00:00.000Z`,
    payload: notGranted
      ? {
          actor: "person-1",
          bot: options.bot ?? BOT,
          server,
          tool: name,
          refusal: "not_granted",
          reason: `${BOT} has not been granted ${server}/${name}.`,
        }
      : {
          actor: "person-1",
          bot: options.bot ?? BOT,
          server,
          tool: name,
          effect: "write",
          attempt: options.attempt ?? `attempt-${sequence}`,
          decision: {
            allowed: eventType !== "mcp.call_rejected",
            mode: "enforce",
          },
          ...(options.refusal ? { refusal: options.refusal } : {}),
        },
  };
}

/** A run's offer, as `mcp.tools_discovered` records it. */
function runRow(bot = BOT): AuditEvent {
  sequence += 1;
  return {
    id: `run-${sequence}`,
    actorUserId: "person-1",
    initiatorKind: "person",
    initiatorId: null,
    eventType: "mcp.tools_discovered",
    targetType: "bot",
    targetId: bot,
    createdAt: "2026-10-30T09:00:00.000Z",
    payload: { bot, reason: "selected", granted: 4, offered: 3, skills: [] },
  };
}

describe("the replay", () => {
  const current = new Set(
    [
      "GMAIL_FETCH_EMAILS",
      "GMAIL_SEND_EMAIL",
      "GMAIL_DELETE_MESSAGE",
      "GMAIL_MOVE_TO_TRASH",
    ].map(ref),
  );
  const proposed = new Set(
    [
      "GMAIL_FETCH_EMAILS",
      "GMAIL_LIST_THREADS",
      "GMAIL_CREATE_EMAIL_DRAFT",
      "GMAIL_UPDATE_DRAFT",
      "GMAIL_ADD_LABEL_TO_EMAIL",
    ].map(ref),
  );
  const events = [
    runRow(),
    runRow(),
    callRow("mcp.call_succeeded", "GMAIL_FETCH_EMAILS"),
    callRow("mcp.call_succeeded", "GMAIL_FETCH_EMAILS"),
    callRow("mcp.call_succeeded", "GMAIL_SEND_EMAIL", {
      at: "2026-11-08T12:00:00.000Z",
    }),
    callRow("mcp.call_failed", "GMAIL_SEND_EMAIL", {
      at: "2026-11-02T12:00:00.000Z",
    }),
    // A call the boundary refused in trial mode writes two rows under one attempt: one call.
    callRow("mcp.call_rejected", "GMAIL_DELETE_MESSAGE", {
      attempt: "trial-1",
    }),
    callRow("mcp.call_succeeded", "GMAIL_DELETE_MESSAGE", {
      attempt: "trial-1",
    }),
    // Reached for twice without having it.
    callRow("mcp.call_rejected", "GMAIL_CREATE_EMAIL_DRAFT", {
      refusal: "not_granted",
    }),
    callRow("mcp.call_rejected", "GMAIL_CREATE_EMAIL_DRAFT", {
      refusal: "not_granted",
    }),
    // Another Bot's calls, and this Bot's calls to another app, are not this replay's.
    callRow("mcp.call_succeeded", "GMAIL_MOVE_TO_TRASH", {
      bot: "agent_other",
    }),
    callRow("mcp.call_succeeded", "SLACK_SEND_MESSAGE", {
      app: "composio-slack",
    }),
    runRow("agent_other"),
  ];

  test("it lists what it takes away that the Bot used, what it gives that the Bot was refused, and the writes it gives that the Bot never reached for", () => {
    const report = replayGrantChange({
      app,
      botId: BOT,
      current,
      proposed,
      events,
    });
    expect(report).toEqual({
      calls: 7,
      runs: 2,
      since: "2026-10-30T09:00:00.000Z",
      removedUsed: [
        {
          ref: ref("GMAIL_SEND_EMAIL"),
          name: "GMAIL_SEND_EMAIL",
          effect: "write",
          destructive: false,
          calls: 2,
          lastCalled: "2026-11-08T12:00:00.000Z",
        },
        {
          ref: ref("GMAIL_DELETE_MESSAGE"),
          name: "GMAIL_DELETE_MESSAGE",
          effect: "write",
          destructive: true,
          calls: 1,
          lastCalled: expect.any(String),
        },
      ],
      callsLost: 3,
      refusedGiven: [
        {
          ref: ref("GMAIL_CREATE_EMAIL_DRAFT"),
          name: "GMAIL_CREATE_EMAIL_DRAFT",
          effect: "write",
          destructive: false,
          calls: 2,
          lastCalled: expect.any(String),
        },
      ],
      callsGained: 2,
      // The trash the Bot never called is taken away silently; the draft it reached for is above.
      addedUnusedWrites: [
        {
          ref: ref("GMAIL_ADD_LABEL_TO_EMAIL"),
          name: "GMAIL_ADD_LABEL_TO_EMAIL",
          destructive: false,
        },
        {
          ref: ref("GMAIL_UPDATE_DRAFT"),
          name: "GMAIL_UPDATE_DRAFT",
          destructive: false,
        },
      ],
      addedUnusedReads: 1,
    });
  });

  test("with no history it says so, and still lists the writes it gives", () => {
    const report = replayGrantChange({
      app,
      botId: BOT,
      current,
      proposed,
      events: [],
    });
    expect(report).toMatchObject({
      calls: 0,
      runs: 0,
      since: null,
      removedUsed: [],
      refusedGiven: [],
      callsLost: 0,
      callsGained: 0,
    });
    expect(report.addedUnusedWrites.map((tool) => tool.name)).toEqual([
      "GMAIL_ADD_LABEL_TO_EMAIL",
      "GMAIL_CREATE_EMAIL_DRAFT",
      "GMAIL_UPDATE_DRAFT",
    ]);
  });
});
