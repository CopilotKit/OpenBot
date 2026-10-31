import { describe, expect, test } from "bun:test";
import {
  ARCADE_VERIFY_PATH,
  arcadeVerifierNotice,
} from "../src/plugins/provider-wiring";

/**
 * Arcade's verifier setting cannot be read back, so an Arcade deployment warns at startup with the
 * exact address its project's custom verifier must be set to.
 */
describe("arcadeVerifierNotice", () => {
  test("names the exact verifier address, what happens without it, and the docs", () => {
    const notice = arcadeVerifierNotice("https://openbot.example.com");
    expect(notice).toContain(
      "https://openbot.example.com/api/plugins/arcade/verify",
    );
    expect(notice).toContain("cannot check");
    expect(notice).toContain("verify route is never called");
    expect(notice).toContain("docs/plugins/arcade.md");
  });

  test("a trailing slash on the origin does not double the separator", () => {
    expect(arcadeVerifierNotice("https://openbot.example.com/")).toContain(
      "https://openbot.example.com/api/plugins/arcade/verify",
    );
  });

  test("with no public origin it says which variables are missing instead of inventing one", () => {
    const notice = arcadeVerifierNotice(undefined);
    expect(notice).toContain(ARCADE_VERIFY_PATH);
    expect(notice).toContain("OPENBOT_PUBLIC_URL");
    expect(notice).not.toContain("undefined");
  });
});
