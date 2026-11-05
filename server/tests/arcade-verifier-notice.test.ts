import { describe, expect, test } from "bun:test";
import {
  ARCADE_VERIFY_PATH,
  arcadeVerifierAddress,
  arcadeVerifierNotice,
} from "../src/plugins/provider-wiring";

/**
 * An Arcade deployment points its project's user verifier at itself before every consent, at the
 * address built here. It warns at startup only when it does not know its own origin and so cannot.
 */
describe("arcadeVerifierAddress", () => {
  test("is the public origin followed by the verify route", () => {
    expect(arcadeVerifierAddress("https://openbot.example.com")).toBe(
      "https://openbot.example.com/api/plugins/arcade/verify",
    );
  });

  test("a trailing slash on the origin does not double the separator", () => {
    expect(arcadeVerifierAddress("https://openbot.example.com/")).toBe(
      "https://openbot.example.com/api/plugins/arcade/verify",
    );
  });

  test("there is none without an origin", () => {
    expect(arcadeVerifierAddress(undefined)).toBeUndefined();
    expect(arcadeVerifierAddress("  ")).toBeUndefined();
  });
});

describe("arcadeVerifierNotice", () => {
  test("says nothing when the deployment knows its origin and points the verifier itself", () => {
    expect(arcadeVerifierNotice("https://openbot.example.com")).toBeNull();
  });

  test("with no public origin it says which variables are missing instead of inventing one", () => {
    const notice = arcadeVerifierNotice(undefined);
    expect(notice).toContain(ARCADE_VERIFY_PATH);
    expect(notice).toContain("OPENBOT_PUBLIC_URL");
    expect(notice).toContain("docs/plugins/arcade.md");
    expect(notice).not.toContain("undefined");
  });
});
