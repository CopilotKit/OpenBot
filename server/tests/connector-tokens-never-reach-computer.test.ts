import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { environmentFor } from "../../supervisor/src/environment";

/**
 * "Connector tokens are never stored on the computer."
 *
 * Checked two ways. Structurally: nothing a Bot's computer runs (agent-computer) and nothing the
 * server sends it through (server/src/computer) can reach the credential vault or the connector
 * store. And at the one place a computer's environment is built: the supervisor forwards a fixed
 * list, so a deployment's secrets stay behind however many of them the server's own environment has.
 */
const root = join(import.meta.dir, "..", "..");

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? sources(join(directory, entry.name))
        : entry.name.endsWith(".ts")
          ? [join(directory, entry.name)]
          : [],
    ),
  );
  return files.flat();
}

const FORBIDDEN =
  /from\s+["'](?:\.\.\/)+(?:credentials|plugins\/[^"']*|passwords\/(?:store|service)|provider-oauth[^"']*|google-oauth-transport)["']/;

describe("connector tokens never reach a Bot's computer", () => {
  test("the computer and the server's computer module import no credential or connector code", async () => {
    const files = [
      ...(await sources(join(root, "agent-computer", "src"))),
      ...(await sources(join(root, "server", "src", "computer"))),
    ];
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (FORBIDDEN.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("a computer's environment carries none of the deployment's secrets", () => {
    const placeholder = "placeholder-connector-value-0000";
    const env = environmentFor("bot-1", {
      COMPUTER_TOKEN: "computer-token",
      KEY_ENCRYPTION_KEY: placeholder,
      COMPOSIO_API_KEY: placeholder,
      GOOGLE_OAUTH_CLIENT_SECRET: placeholder,
      DATABASE_URL: `postgres://openbot:${placeholder}@127.0.0.1/openbot`,
      INTELLIGENCE_API_KEY: placeholder,
      SLACK_BOT_TOKEN: placeholder,
      EGRESS_PROXY_BOT_1: "http://127.0.0.1:3128",
    });
    expect(env.join("\n")).not.toContain(placeholder);
    expect(env).toContain("COMPUTER_BOT_ID=bot-1");
  });
});
