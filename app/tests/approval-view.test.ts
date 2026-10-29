import { expect, test } from "bun:test";
import {
  approvalOutcome,
  approvalPlace,
  clockTime,
  decisionReceipt,
  describeApproval,
  personWasAsked,
} from "@/lib/approval-view";
import type { ApprovalRequest } from "@/lib/approvals";

const action = (
  toolRef: string,
  args: unknown,
  extra: Partial<ApprovalRequest["action"]> = {},
): Pick<ApprovalRequest, "action"> => ({
  action: {
    botId: "inbox",
    toolRef,
    effect: "write",
    scope: "*",
    threadId: "t",
    args,
    target: {},
    ...extra,
  },
});

test("an app's send tool reads as the action, with the app named apart", () => {
  const view = describeApproval(
    action("gmail/GMAIL_SEND_EMAIL", {
      recipient_email: "ana@example.com",
      subject: "Ship date",
      body: "Hi Ana",
      thread_id: "abc",
    }),
  );
  expect(view.title).toBe("Send your email");
  expect(view.app).toBe("Gmail");
  expect(view.kind).toBe("mail");
  expect(view.fields).toEqual([
    { label: "To", value: "ana@example.com" },
    { label: "Subject", value: "Ship date" },
  ]);
  expect(view.body).toBe("Hi Ana");
});

test("an app reached through a broker is named as the app, never the broker", () => {
  const view = describeApproval(
    action("composio-gmail/GMAIL_SEND_EMAIL", { to: "sam@example.com" }),
  );
  expect(view.title).toBe("Send your email");
  expect(view.app).toBe("Gmail");
});

test("any other app's tool is named in words, with the app beside it", () => {
  const view = describeApproval(
    action("notion/create_page", { title: "Launch notes" }),
  );
  expect(view.title).toBe("Create page");
  expect(view.app).toBe("Notion");
  expect(view.kind).toBe("other");
  expect(view.fields).toEqual([{ label: "Title", value: "Launch notes" }]);
});

test("a browser action keeps what it acts on and drops the page plumbing", () => {
  const request = action(
    "computer_click",
    { element: "Pay now", ref: "e7", snapshotId: 3 },
    { scope: "shop.example" },
  );
  const view = describeApproval(request);
  // Named as its step in the conversation names it, so the card and the line above it agree.
  expect(view.title).toBe("Click on the page");
  expect(view.app).toBeNull();
  expect(view.kind).toBe("browser");
  expect(view.fields).toEqual([{ label: "Element", value: "Pay now" }]);
  expect(approvalPlace(request)).toBe("shop.example");
});

test("a command on the person's computer names the command and its folder, not the grant", () => {
  const request = action(
    "host/run_command",
    {
      kind: "run_command",
      botId: "inbox",
      actorId: "user-1",
      grantId: "grant-9",
      command: "ls -la",
    },
    {
      scope: "grant-9",
      target: { grantId: "grant-9", displayName: "Projects" },
    },
  );
  const view = describeApproval(request);
  expect(view.title).toBe("Run command");
  expect(view.kind).toBe("command");
  expect(view.fields).toEqual([{ label: "Command", value: "ls -la" }]);
  expect(approvalPlace(request)).toBe("Projects");
});

test("handing work to another Bot says so, and the Bot it goes to is a field, not a place", () => {
  const request = action(
    "bot/message_bot",
    { bot: "knowledge", message: "Find the March invoice." },
    { scope: "knowledge" },
  );
  const view = describeApproval(request);
  expect(view.title).toBe("Ask another Bot");
  expect(view.kind).toBe("other");
  expect(view.fields).toEqual([{ label: "Bot", value: "knowledge" }]);
  expect(view.body).toBe("Find the March invoice.");
  expect(approvalPlace(request)).toBeNull();
});

test("a scope that is only the app's own id, or anything, is no place", () => {
  expect(
    approvalPlace(action("notion/create_page", {}, { scope: "notion" })),
  ).toBeNull();
  expect(approvalPlace(action("notion/create_page", {}))).toBeNull();
  // The computer's own "its workspace" is not a place either.
  expect(
    approvalPlace(action("computer_run_command", {}, { scope: "workspace" })),
  ).toBeNull();
});

test("who decided, in the person's words", () => {
  expect(decisionReceipt({ decision: "allow_once" })).toBe(
    "Allowed once by you",
  );
  expect(decisionReceipt({ decision: "allow_always" })).toBe(
    "Always allowed here by you",
  );
  expect(decisionReceipt({ decision: "deny" })).toBe("Declined by you");
  expect(decisionReceipt({ decision: "handled" })).toBe("You did it yourself");
  expect(decisionReceipt({ decision: null })).toBeNull();
});

test("how it ended: allowed, sent, done, declined, or did not work", () => {
  const mail = action("gmail/GMAIL_SEND_EMAIL", {}).action;
  const ended = (
    request: Partial<Pick<ApprovalRequest, "status" | "result" | "decision">>,
  ) =>
    approvalOutcome({
      status: "completed",
      result: null,
      decision: "allow_once",
      action: mail,
      ...request,
    });
  expect(ended({ status: "pending", decision: null })).toBeNull();
  expect(ended({ status: "approved" })).toEqual({
    label: "Allowed",
    tone: "working",
  });
  expect(ended({})).toEqual({ label: "Sent", tone: "done" });
  expect(ended({ result: { error: "boom" } })).toEqual({
    label: "Didn't work",
    tone: "needs",
  });
  // Marked done by the person: nothing was sent by the Bot.
  expect(ended({ decision: "handled" })).toEqual({
    label: "Done",
    tone: "done",
  });
  expect(
    approvalOutcome({
      status: "completed",
      result: null,
      decision: "allow_once",
      action: action("computer_click", {}).action,
    }),
  ).toEqual({ label: "Done", tone: "done" });
});

test("a decline stays a decline once the server has finished it with the decline as its error", () => {
  const mail = action("gmail/GMAIL_SEND_EMAIL", {}).action;
  for (const status of ["denied", "completed"])
    expect(
      approvalOutcome({
        status,
        decision: "deny",
        result: { error: "The person declined this action." },
        action: mail,
      }),
    ).toEqual({ label: "Declined", tone: "neutral" });
});

test("a time today is a clock time; an earlier one is a date", () => {
  const now = new Date(2026, 9, 21, 15, 0);
  expect(clockTime(new Date(2026, 9, 21, 14, 59).toISOString(), now)).toMatch(
    /2:59/,
  );
  expect(clockTime(new Date(2026, 9, 20, 9, 0).toISOString(), now)).toMatch(
    /20/,
  );
  expect(clockTime("not a date", now)).toBe("");
});

test("a send the private-share check asks about reads as the email it is", () => {
  const view = describeApproval({
    action: {
      toolRef: "openbot/share_private_information",
      args: {
        audience: "composio-gmail: ana@hearthandco.example",
        recipients: 0,
        contentDigest: "9f2c",
        preview: "Hi Ana, our kiln is down until Monday.",
      },
    },
  } as never);
  expect(view).toEqual({
    title: "Send email",
    app: "Gmail",
    kind: "mail",
    fields: [{ label: "To", value: "ana@hearthandco.example" }],
    body: "Hi Ana, our kiln is down until Monday.",
  });
});

test("a share the person allowed is allowed, not sent: the Bot sends it again itself", () => {
  expect(
    approvalOutcome({
      status: "completed",
      result: null,
      decision: "allow_once",
      action: {
        toolRef: "openbot/share_private_information",
        args: { audience: "composio-gmail: ana@hearthandco.example" },
      },
    } as never),
  ).toEqual({ label: "Allowed", tone: "done" });
});

test("a send put to the person by the share check counts as asked, and its recipients are not a place", () => {
  const share = {
    action: {
      toolRef: "openbot/share_private_information",
      scope: "external:ana@hearthandco.example",
      args: {},
    },
  } as never;
  expect(personWasAsked(share)).toBe(true);
  expect(approvalPlace(share)).toBeNull();
  expect(
    personWasAsked({
      action: { toolRef: "gmail/send_reply", scope: "x", args: {} },
    } as never),
  ).toBe(false);
});

test("typing into a page reads as the step does, and a yes-or-no argument reads as Yes or No", () => {
  const view = describeApproval(
    action(
      "computer_type",
      { ref: "e3", text: "OpenBot", submit: true },
      { scope: "en.wikipedia.org" },
    ),
  );
  expect(view.title).toBe("Fill in a field");
  expect(view.body).toBe("OpenBot");
  expect(view.fields).toEqual([{ label: "Submit after typing", value: "Yes" }]);
});
