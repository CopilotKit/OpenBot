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
 * belonged to another OpenBot account: a false claim about their own account, and one with no
 * action attached. The server distinguishes the two keys, so this page has to as well — and an
 * unrecognised or absent code has to fall back to the claim that is safe to make.
 */
test("says which of the two conflicts happened, and falls back to the safe one", () => {
  expect(slackLinkResult(409, "provider_identity_linked").message).toBe(
    "That Slack identity is already linked to another OpenBot account.",
  );
  expect(slackLinkResult(409, "openbot_user_linked").message).toBe(
    "Your OpenBot account is already linked to a different Slack user in this workspace. Unlink it before linking this one.",
  );
  expect(slackLinkResult(409).message).toBe(
    slackLinkResult(409, "provider_identity_linked").message,
  );

  expect(slackLinkConflict({ conflict: "openbot_user_linked" })).toBe(
    "openbot_user_linked",
  );
  expect(slackLinkConflict({ conflict: "provider_identity_linked" })).toBe(
    "provider_identity_linked",
  );
  for (const body of [
    null,
    undefined,
    {},
    { conflict: 42 },
    { conflict: "something_else" },
    ["openbot_user_linked"],
  ]) {
    expect(slackLinkConflict(body)).toBe("provider_identity_linked");
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
