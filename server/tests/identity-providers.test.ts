import { expect, test } from "bun:test";
import {
  acceptsMethod,
  GITHUB_DOTCOM_REALM,
  isIdentityProvider,
  PROVIDERS,
  parseIdentity,
  slackRealm,
} from "../src/identity/providers";
import { IdentityInputError } from "../src/identity/types";

test("slackRealm keeps connection, installation and workspace", () => {
  expect(
    slackRealm({
      connectionId: "openbot",
      installationId: "I1",
      workspaceId: "T1",
    }),
  ).toBe("openbot:I1:T1");
});

test("slackRealm cannot be confused by a colon", () => {
  const a = slackRealm({
    connectionId: "a:b",
    installationId: "c",
    workspaceId: "d",
  });
  const b = slackRealm({
    connectionId: "a",
    installationId: "b:c",
    workspaceId: "d",
  });
  expect(a).not.toBe(b);
});

test("slackRealm refuses an empty part", () => {
  expect(() =>
    slackRealm({ connectionId: "", installationId: "I1", workspaceId: "T1" }),
  ).toThrow(IdentityInputError);
});

test("GitHub's realm is its host", () => {
  expect(GITHUB_DOTCOM_REALM).toBe("github.com");
});

test("each provider declares the proofs it accepts", () => {
  expect(acceptsMethod("slack", "challenge")).toBe(true);
  expect(acceptsMethod("slack", "oauth")).toBe(false);
  expect(acceptsMethod("github", "oauth")).toBe(true);
  expect(acceptsMethod("github", "challenge")).toBe(false);
});

test("Slack tells the person to send the code to the bot", () => {
  const code = "123e4567-e89b-42d3-a456-426614174000";
  expect(PROVIDERS.slack.instruction?.(code)).toBe(
    `Send this message to the OpenBot bot in Slack: link ${code}`,
  );
  expect(PROVIDERS.github.instruction).toBeUndefined();
});

test("isIdentityProvider", () => {
  expect(isIdentityProvider("slack")).toBe(true);
  expect(isIdentityProvider("myspace")).toBe(false);
  expect(isIdentityProvider(1)).toBe(false);
});

test("parseIdentity strips extra properties and bounds sizes", () => {
  expect(
    parseIdentity({
      provider: "github",
      realm: "github.com",
      subject: "42",
      userId: "x",
    }),
  ).toEqual({ provider: "github", realm: "github.com", subject: "42" });
  expect(() =>
    parseIdentity({ provider: "nope", realm: "r", subject: "s" }),
  ).toThrow(IdentityInputError);
  expect(() =>
    parseIdentity({ provider: "slack", realm: "r", subject: "s".repeat(257) }),
  ).toThrow(IdentityInputError);
  expect(() =>
    parseIdentity({ provider: "slack", realm: "", subject: "s" }),
  ).toThrow(IdentityInputError);
});
