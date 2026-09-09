import { expect, test } from "bun:test";
import {
  slackLinkClaim,
  slackLinkConflict,
  slackLinkFailure,
  slackLinkResponseOutcome,
  slackLinkResult,
  slackLinkToken,
} from "@/routes/_authed/link/slack";

test("requires a token and maps completion responses", () => {
  expect(slackLinkToken({})).toBeNull();
  expect(slackLinkToken({ token: " claim " })).toBe("claim");
  expect(slackLinkResult(200)).toEqual({
    kind: "linked",
    message: "Slack is linked to your OpenBot account.",
  });
  expect(slackLinkResult(409).kind).toBe("conflict");
});

/**
 * The two 409s say opposite things, and only one of them is about somebody else.
 *
 * A person re-linking under a new Slack id in the same workspace used to be told their identity
 * belonged to another OpenBot account: a false claim about their own account. The server
 * distinguishes the two keys, so this page has to as well.
 */
test("says which of the two conflicts happened", () => {
  expect(slackLinkResult(409, "provider_identity_linked").message).toBe(
    "That Slack identity is already linked to another OpenBot account. Ask an administrator to change it.",
  );
  expect(slackLinkResult(409, "openbot_user_linked").message).toBe(
    "Your OpenBot account is already linked to a different Slack user in this workspace. Ask an administrator to change it.",
  );

  expect(slackLinkConflict({ conflict: "openbot_user_linked" })).toBe(
    "openbot_user_linked",
  );
  expect(slackLinkConflict({ conflict: "provider_identity_linked" })).toBe(
    "provider_identity_linked",
  );
});

/**
 * With no code, this page claims nothing about who owns what.
 *
 * Neither named conflict is a safe default: both assert ownership, and the case with no code is
 * the one case where this page does not know which. Reachable on a partial deploy — a new app
 * against a server that does not send `conflict` yet sends every 409 down here — so what is
 * asserted is that no unrecognised body can produce either claim.
 */
test("never guesses which conflict it was", () => {
  const claims = [
    slackLinkResult(409, "provider_identity_linked").message,
    slackLinkResult(409, "openbot_user_linked").message,
  ];

  for (const body of [
    null,
    undefined,
    {},
    { conflict: 42 },
    { conflict: "something_else" },
    { conflict: null },
    ["openbot_user_linked"],
    "openbot_user_linked",
  ]) {
    expect(slackLinkConflict(body)).toBe("unknown");
    expect(claims).not.toContain(
      slackLinkResult(409, slackLinkConflict(body)).message,
    );
  }

  // And the same when the status is all the page was given.
  expect(claims).not.toContain(slackLinkResult(409).message);
  expect(slackLinkResult(409).message).toBe(
    "Slack could not be linked because of a conflict with an existing link. Ask an administrator to look at it.",
  );
});

/**
 * Nothing here tells somebody to unlink, because nothing can.
 *
 * There is no unlink route, no unlink screen and no delete against `external_user_links` in the
 * server. A sentence naming that action would be a dead end dressed as a next step, which is the
 * same failure as the false claim this pair replaced.
 */
test("names an action the deployment actually has", () => {
  for (const conflict of [
    "provider_identity_linked",
    "openbot_user_linked",
    "unknown",
  ] as const) {
    const { message } = slackLinkResult(409, conflict);
    expect(message).toContain("administrator");
    expect(message.toLowerCase()).not.toContain("unlink");
  }
});

test("rejects non-string, empty, and repeated token search inputs", () => {
  expect(slackLinkToken({ token: "" })).toBeNull();
  expect(slackLinkToken({ token: "   " })).toBeNull();
  expect(slackLinkToken({ token: ["first", "second"] })).toBeNull();
  expect(slackLinkToken({ token: { value: "claim" } })).toBeNull();
  expect(slackLinkToken({ token: 42 })).toBeNull();
});

test("maps invalid and expired completion statuses uniformly", () => {
  expect(slackLinkResult(400)).toEqual({
    kind: "invalid",
    message:
      "This Slack link has expired or is invalid. Return to Slack and try again.",
  });
  expect(slackLinkResult(410).kind).toBe("invalid");
});

test("keeps unexpected server failures retryable", () => {
  expect(slackLinkFailure()).toEqual({
    kind: "error",
    message: "Slack could not be linked right now. Try again.",
  });
});

test("classifies documented token, authentication, and transient responses", () => {
  for (const status of [400]) {
    expect(slackLinkResponseOutcome(status).kind).toBe("invalid");
  }
  expect(slackLinkResponseOutcome(409).kind).toBe("conflict");
  expect(
    slackLinkResponseOutcome(409, "openbot_user_linked").message,
  ).toContain("a different Slack user in this workspace");
  // Status alone claims nothing, the same as an unrecognised body.
  expect(slackLinkResponseOutcome(409).message).toBe(
    slackLinkResult(409, "unknown").message,
  );
  expect(slackLinkResponseOutcome(401).kind).toBe("reauth");

  for (const status of [408, 418, 425, 429, 500, 502, 503]) {
    expect(slackLinkResponseOutcome(status).kind).toBe("error");
  }
  expect(slackLinkResponseOutcome().kind).toBe("error");
});

test("maps only safe Slack identity fields for display", () => {
  expect(
    slackLinkClaim({
      providerTenantId: "T0123",
      providerUserId: "U0456",
      providerEmail: "person@example.com",
      token: "must not be displayed",
    }),
  ).toEqual({
    workspace: "T0123",
    user: "U0456",
    email: "person@example.com",
  });
  expect(
    slackLinkClaim({
      providerTenantId: "T0123",
      providerUserId: "U0456",
      providerEmail: null,
    }),
  ).toEqual({ workspace: "T0123", user: "U0456" });
  expect(slackLinkClaim({ providerTenantId: "T0123" })).toBeNull();
});
