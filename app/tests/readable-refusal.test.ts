import { expect, test } from "bun:test";
import { readableRefusal } from "@/lib/plugins/readable-refusal";

/**
 * The banner over an app's page when a key check fails. On the Mac pass it showed Fireflies' whole
 * JSON reply, which the server had quoted into its sentence. Whatever the server sends, no envelope
 * reaches the screen.
 */

const FALLBACK = "That key didn't pass its check.";

test("the Mac pass banner loses Fireflies' JSON and keeps the sentence around it", () => {
  const sent =
    'fireflies was connected, and the check this deployment then ran against it did not come back clean: {"errors":[{"friendly":true,"code":"auth_failed","message":"An error occurred while authenticating your request. Please recheck your API key and try again.","extensions":{"code":"auth_failed"}}]} That may be the key. Re-check it on the Connections page once.';
  const shown = readableRefusal(sent, FALLBACK);
  expect(shown).not.toMatch(/[{}[\]]/);
  expect(shown).not.toContain("auth_failed");
  expect(shown).toContain("That may be the key.");
});

test("a plain sentence is shown as the server wrote it", () => {
  const sent =
    "Fireflies didn't accept that key. Fireflies said: “An error occurred while authenticating your request.” Disconnect, then connect again with a key copied from your Fireflies account.";
  expect(readableRefusal(sent, FALLBACK)).toBe(sent);
});

test("a body with nothing around it is replaced by the screen's own words", () => {
  expect(readableRefusal('{"errors":[{"code":"auth_failed"}]}', FALLBACK)).toBe(
    FALLBACK,
  );
  expect(readableRefusal("", FALLBACK)).toBe(FALLBACK);
});
