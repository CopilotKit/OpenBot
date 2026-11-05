import { describe, expect, test } from "bun:test";
import {
  ARCADE_VERIFY_PATH,
  arcadeVerifierAddress,
  arcadeVerifierNotice,
  ownsBrokerProject,
} from "../src/plugins/provider-wiring";

/**
 * An Arcade deployment checks its project's user verifier names the address built here before every
 * consent; a single-user install points it there. Startup says which address an admin sets where
 * the deployment may not, and which variable is missing where it does not know its origin.
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
  test("says nothing when the install owns its project and knows its origin", () => {
    expect(
      arcadeVerifierNotice("https://openbot.example.com", {
        ownsProject: true,
      }),
    ).toBeNull();
  });

  test("a deployment that signs people in names the exact address an admin sets", () => {
    const notice = arcadeVerifierNotice("https://openbot.example.com", {
      ownsProject: false,
    });
    expect(notice).toContain(
      "https://openbot.example.com/api/plugins/arcade/verify",
    );
    expect(notice).toContain("never changes the project's user verifier");
    expect(notice).toContain("docs/plugins/arcade.md");
  });

  test("with no public origin it says which variables are missing instead of inventing one", () => {
    for (const ownsProject of [true, false]) {
      const notice = arcadeVerifierNotice(undefined, { ownsProject });
      expect(notice).toContain(ARCADE_VERIFY_PATH);
      expect(notice).toContain("OPENBOT_PUBLIC_URL");
      expect(notice).not.toContain("undefined");
    }
  });
});

describe("ownsBrokerProject", () => {
  test("a single-user install owns its project and a deployment that signs people in does not", () => {
    expect(ownsBrokerProject({ singleUser: true })).toBe(true);
    expect(ownsBrokerProject({ singleUser: false })).toBe(false);
    expect(ownsBrokerProject({})).toBe(false);
  });
});
