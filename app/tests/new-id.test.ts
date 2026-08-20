import { afterEach, describe, expect, test } from "bun:test";
import { newId } from "../src/lib/new-id";

/**
 * The identifiers a surface mints, on an origin that is not a secure context.
 *
 * A deployment reached at `http://<address>` has no `crypto.randomUUID`, and the app used to call it
 * directly. The throw landed inside a submit handler, React swallowed it, and the chat did nothing
 * at all. These assert the fallback rather than the happy path, because the happy path is the one
 * that was never broken.
 */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const original = crypto.randomUUID;

/** An origin that is not a secure context, which is what the absent function means in practice. */
function withoutRandomUUID(): void {
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: undefined,
  });
}

afterEach(() => {
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: original,
  });
});

describe("newId", () => {
  test("mints a UUID where randomUUID exists", () => {
    expect(newId()).toMatch(UUID_V4);
  });

  test("mints one where it does not", () => {
    withoutRandomUUID();

    expect(newId()).toMatch(UUID_V4);
  });

  test("does not repeat itself without randomUUID", () => {
    withoutRandomUUID();

    const ids = new Set(Array.from({ length: 1000 }, () => newId()));

    expect(ids.size).toBe(1000);
  });
});
