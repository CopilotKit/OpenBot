import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  extensionIdFromOrigin,
  RECORDER_EXTENSION_ID,
  recorderExtensionIds,
} from "./recorder-extension";

/** Chrome's extension id: SHA-256 of the DER public key, first 32 hex digits mapped 0-f -> a-p. */
async function extensionIdFromPublicKey(base64Der: string): Promise<string> {
  const der = Uint8Array.from(atob(base64Der.trim()), (character) =>
    character.charCodeAt(0),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
  const hex = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return Array.from(hex.slice(0, 32), (digit) =>
    String.fromCharCode(97 + Number.parseInt(digit, 16)),
  ).join("");
}

const publicKey = readFileSync(
  new URL("../extension/keys/public-key.txt", import.meta.url),
  "utf8",
).trim();
const id = "icpcnhgjghecmklnjbccdgdicklblcgd";

test("the committed public key derives the one extension id", async () => {
  expect(await extensionIdFromPublicKey(publicKey)).toBe(RECORDER_EXTENSION_ID);
  expect(RECORDER_EXTENSION_ID).toBe(id);
});

test("the derivation matches a vector computed with openssl", async () => {
  // printf openbot | base64 | base64 -d | openssl dgst -sha256 -binary | xxd -p -c 64 | cut -c1-32 | tr '0-9a-f' 'a-p'
  expect(await extensionIdFromPublicKey("b3BlbmJvdA==")).toBe(
    "fffgjjbhnklfhmeochieojhodiegmggn",
  );
});

test("the fixed id comes first and extras are deduplicated", () => {
  expect(recorderExtensionIds()).toEqual([id]);
  expect(recorderExtensionIds({ extra: ["a".repeat(32), id] })).toEqual([
    id,
    "a".repeat(32),
  ]);
});

test("an extension origin maps to its id with or without the trailing slash", () => {
  expect(extensionIdFromOrigin(`chrome-extension://${id}`, [id])).toBe(id);
  expect(extensionIdFromOrigin(`chrome-extension://${id}/`, [id])).toBe(id);
});

test("other origins and unknown ids map to nothing", () => {
  expect(extensionIdFromOrigin("https://x.test", [id])).toBeNull();
  expect(
    extensionIdFromOrigin(`chrome-extension://${"b".repeat(32)}`, [id]),
  ).toBeNull();
  expect(extensionIdFromOrigin(null, [id])).toBeNull();
  expect(extensionIdFromOrigin(undefined, [id])).toBeNull();
});
