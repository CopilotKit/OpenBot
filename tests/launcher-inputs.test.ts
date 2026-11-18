/**
 * The launcher contract check (scripts/check-launcher-inputs.ts), on the real Compose file and the
 * recorded launch of OpenBot Desktop 1.1.0, read by Compose itself.
 *
 * Its reason to exist: what OpenBot Desktop hands the server goes through this repository's
 * docker-compose.yml, and a change to that file can take a setting the app gives away from the
 * server, or make Compose refuse what the app wrote, without anything here noticing. Each case
 * below makes such a change to a copy of the real file and expects the check to fail it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPOSE_FILE,
  composeAvailable,
  launcherInputProblems,
  publishedLauncherApi,
  recordedContracts,
} from "../scripts/check-launcher-inputs";

const work = mkdtempSync(join(tmpdir(), "openbot-launcher-inputs-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const real = readFileSync(COMPOSE_FILE, "utf8");

/** A copy of the real Compose file with one line replaced, which must be there to replace. */
function composeWith(name: string, line: string, replacement: string): string {
  expect(real).toContain(line);
  const path = join(work, `${name}.yml`);
  writeFileSync(path, real.replace(line, replacement));
  return path;
}

const contract = (number: number) => {
  const found = recordedContracts().find(
    (recorded) => recorded.launcherApi === number,
  );
  if (!found) throw new Error(`No recorded launcherApi ${number}.`);
  return found;
};

/** One line of the `server` service's environment: `name`, from the Compose variable `source`. */
const setting = (name: string, source: string) =>
  `      ${name}: \${${source}:-}\n`;

const INSTALL_TOKEN = setting("OPENBOT_INSTALL_TOKEN", "OPENBOT_INSTALL_TOKEN");

describe.skipIf(!composeAvailable)("the launcher contract check", () => {
  test("this release's Compose file hands the server everything the app of the published number gives it", () => {
    expect(
      launcherInputProblems({
        launcherApi: publishedLauncherApi(),
        contracts: recordedContracts(),
      }),
    ).toEqual([]);
  });

  test("a Compose file that stops handing the server a secret the app gives fails, and says to raise launcherApi", () => {
    for (const [lost, composeFile] of [
      // 1.1.0's own break, from this side: the install token no longer reaches the server.
      ["OPENBOT_INSTALL_TOKEN", composeWith("dropped", INSTALL_TOKEN, "")],
      [
        "OPENBOT_INSTALL_TOKEN",
        composeWith(
          "renamed",
          INSTALL_TOKEN,
          setting("OPENBOT_INSTALL_TOKEN", "OPENBOT_INSTALL_SECRET"),
        ),
      ],
      // A tidy-up that reads the server's own name for the Learning token, which the app hands
      // Compose as LEARNING_MODEL_TOKEN: Compose still reads the file, and the server goes without.
      [
        "OPENBOT_LEARNING_MODEL_TOKEN",
        composeWith(
          "learning-token-renamed",
          setting("OPENBOT_LEARNING_MODEL_TOKEN", "LEARNING_MODEL_TOKEN"),
          setting(
            "OPENBOT_LEARNING_MODEL_TOKEN",
            "OPENBOT_LEARNING_MODEL_TOKEN",
          ),
        ),
      ],
    ] as const) {
      const problems = launcherInputProblems({
        launcherApi: 1,
        contracts: [contract(1)],
        composeFile,
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(
        `no longer hands the server ${lost} from what OpenBot Desktop 1.1.0 (launcherApi 1) gives it`,
      );
      expect(problems[0]).toContain(
        "Raise compatibility.launcherApi in release-policy.json to 2",
      );
    }
  });

  test("a Compose file that requires a setting the app never writes fails with Compose's own words", () => {
    const composeFile = composeWith(
      "required",
      INSTALL_TOKEN,
      `${INSTALL_TOKEN}      OPENBOT_NEW_SETTING: \${OPENBOT_NEW_SETTING:?is required}\n`,
    );
    const problems = launcherInputProblems({
      launcherApi: 1,
      contracts: [contract(1)],
      composeFile,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      "Compose refuses this release's docker-compose.yml with what OpenBot Desktop 1.1.0 gives it",
    );
    expect(problems[0]).toContain("OPENBOT_NEW_SETTING");
  });

  test("a published number with no recorded app fails, and an older recorded app needs only Compose to accept the file", () => {
    expect(
      launcherInputProblems({ launcherApi: 2, contracts: [contract(1)] }),
    ).toEqual([
      "This release publishes launcherApi 2, and no launch of an app of 2 is recorded. Record the first such app's in scripts/launcher-contracts/launcher-api-2.json.",
    ]);
    // Once 2 is recorded, an app of 1 is told to update by the release it lays out; it no longer has
    // to hand the server everything, so a Compose file that leaves out what 1 gave passes for it.
    const composeFile = composeWith("dropped-for-2", INSTALL_TOKEN, "");
    const two = {
      ...contract(1),
      app: "a later app",
      launcherApi: 2,
      server: contract(1).server.filter(
        (setting) => setting !== "OPENBOT_INSTALL_TOKEN",
      ),
    };
    expect(
      launcherInputProblems({
        launcherApi: 2,
        contracts: [contract(1), two],
        composeFile,
      }),
    ).toEqual([]);
  });
});
