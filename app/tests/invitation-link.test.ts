import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  invitationIn,
  rememberInvitationLink,
  takeInvitationLink,
} from "../src/lib/organizations/invitation-link";

/**
 * An invitation's link is kept while its person signs in, and followed once.
 *
 * The rule that matters is what may be kept: an invitation's own address and nothing else, so a
 * link can never choose where a person lands after signing in.
 */

const kept = new Map<string, string>();
const realStorage = globalThis.sessionStorage;

beforeEach(() => {
  kept.clear();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
    },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: realStorage,
  });
});

describe("an invitation's link across sign-in", () => {
  test("is remembered when a signed-out person opens it, and followed once", () => {
    rememberInvitationLink("/invitations/5b0f6f0e-6f0b-4c0e-9d57-0d6f3a5f9a11");
    expect(takeInvitationLink()).toBe("5b0f6f0e-6f0b-4c0e-9d57-0d6f3a5f9a11");
    // Home after that is home.
    expect(takeInvitationLink()).toBeUndefined();
  });

  test("nothing but an invitation's own address is kept", () => {
    for (const address of [
      "/",
      "/invitations",
      "/invitations/",
      "/settings/organization",
      "/invitations/abc/accept",
      "/invitations/abc?next=https://elsewhere.example",
      "/invitations/../admin",
      "//elsewhere.example/invitations/abc",
      `/invitations/${"a".repeat(129)}`,
    ]) {
      rememberInvitationLink(address);
      expect(takeInvitationLink(), address).toBeUndefined();
    }
  });

  test("something else written where the link is kept is not followed", () => {
    kept.set("openbot.invitation-link", "../admin");
    expect(takeInvitationLink()).toBeUndefined();
    kept.set("openbot.invitation-link", "abc/accept");
    expect(takeInvitationLink()).toBeUndefined();
  });

  test("a tab with no storage loses the link and nothing else", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("storage is blocked");
      },
    });
    expect(() => rememberInvitationLink("/invitations/abc")).not.toThrow();
    expect(takeInvitationLink()).toBeUndefined();
  });

  test("the invitation an address names", () => {
    expect(invitationIn("/invitations/abc_DEF-123")).toBe("abc_DEF-123");
    expect(invitationIn("/invitations/abc def")).toBeUndefined();
  });
});
