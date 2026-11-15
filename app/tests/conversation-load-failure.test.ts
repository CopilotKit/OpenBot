import { expect, test } from "bun:test";
import { conversationLoadFailure } from "@/lib/channels/load-failure";
import { ClientError } from "@/lib/client";

/**
 * Opening a conversation that this organization does not have, as Back does after a switch, said
 * "Couldn't load this conversation. Reload the page.", and reloading never brought it back.
 */
const notFound = new ClientError("Channel not found", 404);

test("a conversation that isn't in the organization being worked in says so, and where it may be", () => {
  expect(conversationLoadFailure(notFound, "Acme")).toBe(
    "Couldn't find this conversation in Acme. It may be in another of your organizations.",
  );
});

test("with one organization, a conversation that isn't there may have been deleted", () => {
  expect(conversationLoadFailure(notFound)).toBe(
    "Couldn't find this conversation. It may have been deleted.",
  );
});

test("a load that failed for any other reason still says to reload", () => {
  for (const error of [
    new ClientError("Couldn't load this conversation.", 500),
    new ClientError("Sign in to continue.", 401),
    new TypeError("Failed to fetch"),
  ]) {
    expect(conversationLoadFailure(error, "Acme")).toBe(
      "Couldn't load this conversation. Reload the page.",
    );
  }
});
