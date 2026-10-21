import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARCADE_VERIFY_PATH,
  arcadeVerifierNotice,
} from "../src/plugins/provider-wiring";

const source = (path: string) =>
  readFileSync(join(import.meta.dir, "..", "src", path), "utf8");

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

  /*
   * The path in the notice is a copy of where the route is actually mounted, so it is held to it:
   * plugin routes under `/api/plugins` in app.ts, the verify route as `/arcade/verify` on them.
   */
  test("the path it names is the one the verify route is served at", () => {
    expect(ARCADE_VERIFY_PATH).toBe("/api/plugins/arcade/verify");
    expect(source("app.ts")).toMatch(
      /app\.route\(\s*"\/api\/plugins",\s*createPluginRoutes\(/,
    );
    expect(source("plugins/route-groups/connections.ts")).toContain(
      'routes.get("/arcade/verify"',
    );
  });

  test("startup prints it whenever Arcade is the wired provider", () => {
    expect(source("index.ts")).toMatch(
      /if \(wiredProvider === "arcade"\) \{\s*console\.warn\(arcadeVerifierNotice\(config\.publicUrl\)\);/,
    );
  });
});
