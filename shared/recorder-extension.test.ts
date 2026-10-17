import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  extensionIdFromOrigin,
  extensionIdFromPublicKey,
  RECORDER_EXTENSION_ID,
  recorderExtensionIds,
} from "./recorder-extension";

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
