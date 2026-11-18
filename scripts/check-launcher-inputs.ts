#!/usr/bin/env bun
/**
 * What OpenBot Desktop hands the server it starts, held against this release's Compose file.
 *
 * OpenBot Desktop starts the personal edition from the release's own `docker-compose.yml`, with the
 * settings it writes into `.env` beside it and the secrets it hands Compose in its own environment:
 * the launcher inputs. `compatibility.launcherApi` in release-policy.json numbers that contract, and
 * an app reads it before it lays out or starts a release (docs/desktop-updates.md). 1.1.0 began to
 * need a setting no earlier app wrote (OPENBOT_INSTALL_TOKEN) and kept the number, so an older app
 * laid it out and its server exited.
 *
 * The Compose file is where this repository can break that contract by itself: a change there can
 * stop a setting the app gives from reaching the server, or make Compose refuse what the app wrote.
 * So each contract is recorded once, as what the first app of that number hands Compose and which
 * of the server's settings that reaches (scripts/launcher-contracts/launcher-api-<number>.json),
 * and this reads this release's Compose file with each, through Compose itself:
 *
 *   - Compose must accept the file for every recorded launch. An app whose Compose refuses the file
 *     shows a setup that failed, whatever the server would have said.
 *   - For the launch of the number this release publishes, every server setting its record lists
 *     must still reach the server from what the app gives. A setting the server is no longer handed
 *     that way is one the app can no longer give it: a new contract, so the number goes up.
 *   - The number this release publishes must have a record, and no record may be beyond it.
 *
 *   bun scripts/check-launcher-inputs.ts       CI runs it in ci.yml's `static` job
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
export const CONTRACTS = join(import.meta.dir, "launcher-contracts");
export const COMPOSE_FILE = join(ROOT, "docker-compose.yml");

/** One app's launch: the `.env` it writes, the environment it runs Compose in, and what that gives the server. */
export type Launch = {
  app: string;
  launcherApi: number;
  envFile: Record<string, string>;
  environment: Record<string, string>;
  /** The server settings this launch hands the server, by the name the server reads. */
  server: string[];
};

export function readLaunch(path: string): Launch {
  return JSON.parse(readFileSync(path, "utf8")) as Launch;
}

/** The launcher contract this release publishes. */
export function publishedLauncherApi(
  policy = join(ROOT, "release-policy.json"),
): number {
  const read = JSON.parse(readFileSync(policy, "utf8")) as {
    compatibility?: { launcherApi?: unknown };
  };
  const number = read.compatibility?.launcherApi;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    throw new Error(`${policy} has no compatibility.launcherApi.`);
  return number;
}

/** Every recorded contract, by number. */
export function recordedContracts(folder = CONTRACTS): Launch[] {
  return readdirSync(folder)
    .filter((name) => /^launcher-api-\d+\.json$/.test(name))
    .map((name) => {
      const launch = readLaunch(join(folder, name));
      const number = Number(/(\d+)\.json$/.exec(name)?.[1]);
      if (launch.launcherApi !== number)
        throw new Error(
          `${name} records launcherApi ${launch.launcherApi}, not ${number}.`,
        );
      return launch;
    });
}

function dotenv(values: Record<string, string>): string {
  return `# Written by OpenBot Desktop. Anything else in this file is left alone.\n${Object.entries(
    values,
  )
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

/**
 * The `server` service's environment as Compose hands it to the container, for a launch, from
 * `composeFile`. Laid out as the app lays out a release: the Compose file, its `.env`, and the
 * sign-in folder the `server` service mounts, which the app makes before it starts anything. Throws
 * with Compose's own words when Compose refuses the file.
 */
export function composedServerEnvironment(
  launch: Pick<Launch, "app" | "envFile" | "environment">,
  composeFile = COMPOSE_FILE,
): Record<string, string> {
  const folder = mkdtempSync(join(tmpdir(), "openbot-launch-"));
  try {
    writeFileSync(
      join(folder, "docker-compose.yml"),
      readFileSync(composeFile, "utf8"),
    );
    writeFileSync(join(folder, ".env"), dotenv(launch.envFile));
    mkdirSync(join(folder, ".openbot"));
    const result = Bun.spawnSync(
      [
        "docker",
        "compose",
        "--project-directory",
        folder,
        "-f",
        join(folder, "docker-compose.yml"),
        "--profile",
        "openbot",
        "config",
        "--format",
        "json",
      ],
      {
        cwd: folder,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ...(process.env.DOCKER_CONFIG
            ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG }
            : {}),
          ...launch.environment,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (result.exitCode !== 0)
      throw new Error(
        `Compose refuses this release's docker-compose.yml with what OpenBot Desktop ${launch.app} gives it: ${new TextDecoder().decode(result.stderr).trim()}`,
      );
    const config = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      services: { server?: { environment?: Record<string, string | null> } };
    };
    const server = config.services.server;
    if (!server) throw new Error("docker-compose.yml has no `server` service.");
    return Object.fromEntries(
      Object.entries(server.environment ?? {}).map(([key, value]) => [
        key,
        value ?? "",
      ]),
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * The server settings a launch hands the server through `composeFile`: each one the server is given
 * a value for that it is not given when the app writes and hands over nothing. A setting with a
 * default in the Compose file still counts when the app's value replaces the default.
 */
export function launcherGivesServer(
  launch: Pick<Launch, "app" | "envFile" | "environment">,
  composeFile = COMPOSE_FILE,
): string[] {
  const given = composedServerEnvironment(launch, composeFile);
  const bare = composedServerEnvironment(
    { app: launch.app, envFile: {}, environment: {} },
    composeFile,
  );
  return Object.keys(given)
    .filter((key) => given[key] !== "" && given[key] !== bare[key])
    .sort();
}

/** Why this release's Compose file breaks a launcher, one sentence each. Empty when it breaks none. */
export function launcherInputProblems(input: {
  launcherApi: number;
  contracts: Launch[];
  composeFile?: string;
}): string[] {
  const { launcherApi, contracts, composeFile } = input;
  const problems: string[] = [];
  const raise = `Raise compatibility.launcherApi in release-policy.json to ${launcherApi + 1} and record what an app of ${launcherApi + 1} hands Compose in scripts/launcher-contracts/launcher-api-${launcherApi + 1}.json, so an app of ${launcherApi} lays out its own release and offers its update instead.`;
  if (!contracts.some((contract) => contract.launcherApi === launcherApi))
    problems.push(
      `This release publishes launcherApi ${launcherApi}, and no launch of an app of ${launcherApi} is recorded. Record the first such app's in scripts/launcher-contracts/launcher-api-${launcherApi}.json.`,
    );
  for (const contract of contracts) {
    const named = `OpenBot Desktop ${contract.app} (launcherApi ${contract.launcherApi})`;
    if (contract.launcherApi > launcherApi) {
      problems.push(
        `scripts/launcher-contracts records launcherApi ${contract.launcherApi}, beyond the ${launcherApi} this release publishes.`,
      );
      continue;
    }
    let reaches: string[];
    try {
      reaches = launcherGivesServer(contract, composeFile);
    } catch (error) {
      problems.push(
        `${error instanceof Error ? error.message : String(error)} ${named} would show a setup that failed. Keep what the file asks of the app to what that app writes${contract.launcherApi === launcherApi ? `, or: ${raise}` : "."}`,
      );
      continue;
    }
    if (contract.launcherApi !== launcherApi) continue;
    const lost = contract.server.filter(
      (setting) => !reaches.includes(setting),
    );
    if (lost.length > 0)
      problems.push(
        `This release's docker-compose.yml no longer hands the server ${lost.join(", ")} from what ${named} gives it, so a server started by that app goes without. Hand it on as before, or, if the server needs it from somewhere the app does not give: ${raise} If the server no longer reads it at all, take it off the record's \`server\` list in the same change.`,
      );
  }
  return problems;
}

/** Whether this machine has Docker's Compose to read a Compose file with. */
export const composeAvailable = (() => {
  if (Bun.which("docker") === null) return false;
  const probe = Bun.spawnSync(["docker", "compose", "version"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return probe.exitCode === 0;
})();

if (import.meta.main) {
  const launcherApi = publishedLauncherApi();
  const contracts = recordedContracts();
  const problems = launcherInputProblems({ launcherApi, contracts });
  if (problems.length > 0) {
    for (const problem of problems) console.log(`::error::${problem}`);
    process.exit(1);
  }
  console.log(
    `launcherApi ${launcherApi}: this release's docker-compose.yml takes what ${contracts
      .map(
        (contract) =>
          `OpenBot Desktop ${contract.app} (${contract.launcherApi})`,
      )
      .join(", ")} gives, and hands the server everything it handed before.`,
  );
}
