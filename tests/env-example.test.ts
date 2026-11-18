import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * `.env.example` is what a fresh clone copies to `.env`, so what it sets is the default.
 *
 * The default Intelligence is the one on this machine, which the CopilotKit CLI installs and whose
 * addresses `npx copilotkit@latest local connect` writes. Each installation has its own ports, so
 * the example leaves both addresses empty for the CLI to fill, and names the managed service's only
 * in a comment, as the alternative.
 */

const root = join(import.meta.dir, "..");
const example = readFileSync(join(root, ".env.example"), "utf8");
const lines = example.split("\n");

const HOSTED = /intelligence\.copilotkit\.ai/;

test("the example points at no managed Intelligence until somebody chooses it", () => {
  const set = parseEnv(example);
  expect(set.INTELLIGENCE_API_URL).toBe("");
  expect(set.INTELLIGENCE_GATEWAY_WS_URL).toBe("");
  expect(set.CPK_INTELLIGENCE_API_KEY).toBe("");

  // Each is written once, so the line the CLI fills in is the line every reader takes.
  for (const name of ["INTELLIGENCE_API_URL", "INTELLIGENCE_GATEWAY_WS_URL"])
    expect({
      name,
      written: lines.filter((line) => line.startsWith(`${name}=`)).length,
    }).toEqual({ name, written: 1 });

  // The managed addresses are still there to copy, in comments only.
  const hosted = lines.filter((line) => HOSTED.test(line));
  expect(
    hosted.some((line) =>
      line.includes(
        "INTELLIGENCE_API_URL=https://api.intelligence.copilotkit.ai",
      ),
    ),
  ).toBe(true);
  expect(
    hosted.some((line) =>
      line.includes(
        "INTELLIGENCE_GATEWAY_WS_URL=wss://realtime.intelligence.copilotkit.ai",
      ),
    ),
  ).toBe(true);
  expect(hosted.filter((line) => !line.trimStart().startsWith("#"))).toEqual(
    [],
  );
});

test("the example says how the local Intelligence's addresses get written", () => {
  expect(example).toContain("npx --yes copilotkit@latest local setup");
  expect(example).toContain(
    "npx --yes copilotkit@latest local connect --approve-connection",
  );
});

/**
 * The real path after `local connect`: it writes this machine's addresses into the copy of the
 * example, and `scripts/server-env.ts`, which `scripts/start.sh` runs, hands them to the server's
 * container.
 */
test("addresses the CLI writes into a copy of the example reach the server", () => {
  const directory = mkdtempSync(join(tmpdir(), "openbot-env-example-"));
  try {
    const connected = example
      .replace(
        /^INTELLIGENCE_API_URL=$/m,
        "INTELLIGENCE_API_URL=http://localhost:61361",
      )
      .replace(
        /^INTELLIGENCE_GATEWAY_WS_URL=$/m,
        "INTELLIGENCE_GATEWAY_WS_URL=ws://localhost:61363",
      )
      .replace(
        /^CPK_INTELLIGENCE_API_KEY=$/m,
        "CPK_INTELLIGENCE_API_KEY=cpk-synthetic",
      );
    const dotenv = join(directory, ".env");
    const output = join(directory, "server.env");
    writeFileSync(dotenv, connected);
    execFileSync(
      "bun",
      ["--no-env-file", join(root, "scripts/server-env.ts"), dotenv, output],
      {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      },
    );
    const handed = parseEnv(readFileSync(output, "utf8"));
    expect(handed.INTELLIGENCE_API_URL).toBe("http://localhost:61361");
    expect(handed.INTELLIGENCE_GATEWAY_WS_URL).toBe("ws://localhost:61363");
    expect(handed.CPK_INTELLIGENCE_API_KEY).toBe("cpk-synthetic");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * `scripts/server-env.ts` hands the server every setting the example lists, so a line for a setting
 * nothing reads hands the server a setting nothing reads.
 */
test("the example lists no setting that nothing reads", () => {
  for (const name of ["BOT_REASONING_EFFORT", "WORKER_SHARED_SECRET"])
    expect({ name, listed: example.includes(name) }).toEqual({
      name,
      listed: false,
    });
});
