import { describe, expect, test } from "bun:test";
import { createThreadIdentity } from "../src/channels/thread-identity";

/**
 * The thread id as the only place a deployment can write its own name.
 *
 * The platform accepts a client-generated id and nothing else a deployment controls, so these are
 * the properties the id has to hold on its own: it is a UUID the platform will take, it says which
 * deployment minted it, and it says that to a deployment that has never seen the thread before.
 */

const here = createThreadIdentity("openbot-production");
const elsewhere = createThreadIdentity("openbot-staging");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("a thread id carries the deployment that minted it", () => {
  test("it is a well-formed UUID, which is all the platform accepts", () => {
    // A prefixed id is refused by the platform with a validation error, so the tag has to fit inside
    // the format rather than sit beside it.
    expect(here.mint()).toMatch(UUID);
  });

  test("it declares the custom layout rather than claiming to be random", () => {
    // Version 8: RFC 9562 reserves it for a vendor-defined layout, which is what this is.
    expect(here.mint()[14]).toBe("8");
  });

  test("a deployment recognises its own", () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      expect(here.owns(here.mint())).toBe(true);
    }
  });

  test("and does not claim another deployment's", () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      expect(here.owns(elsewhere.mint())).toBe(false);
      expect(elsewhere.owns(here.mint())).toBe(false);
    }
  });

  test("the same name recognises threads minted by another process", () => {
    // Nothing is remembered between runs: a deployment that restarts, or a second copy of the same
    // deployment, has to reach the same answer from the name alone.
    expect(createThreadIdentity("openbot-production").owns(here.mint())).toBe(
      true,
    );
  });

  test("ids differ, so the tag has not eaten the randomness", () => {
    const minted = new Set(Array.from({ length: 1000 }, () => here.mint()));
    expect(minted.size).toBe(1000);
  });

  test("a thread minted before deployments had names is not claimed", () => {
    // A plain version 4 id. Unknown provenance rather than somebody else's, which is a distinction
    // its caller has to make, not this.
    expect(here.owns(crypto.randomUUID())).toBe(false);
  });

  test("anything that is not a UUID is refused rather than parsed", () => {
    for (const value of [
      "",
      "not-a-uuid",
      "openbot-connection-test-123",
      "377529b0-9a52-4fe3-bfaa-b99a3886710",
      "377529b0-9a52-4fe3-bfaa-b99a3886710e-extra",
      "zzzzzzzz-9a52-4fe3-bfaa-b99a3886710e",
    ]) {
      expect(here.owns(value)).toBe(false);
    }
  });
});
