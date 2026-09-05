import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import type { ActionPolicy } from "../src/computer/policy";
import { createPolicyStore } from "../src/computer/policy-store";
import { createDatabase } from "../src/db/client";
import { actionPolicy } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const artifact = resolve(
  import.meta.dir,
  "../../deploy/netsfera/agent-computer-policy.json",
);
const reviewed = JSON.parse(readFileSync(artifact, "utf8")) as ActionPolicy;
const policyStore = createPolicyStore(reviewed, database);
const directory = mkdtempSync(join(tmpdir(), "reviewed-policy-db-"));
const helper = join(directory, "helper");
// Replace only the host transport. Execute the production script's exact SQL
// against real PostgreSQL; Linux controller tests cover the real helper/FD.
writeFileSync(
  helper,
  `#!${process.execPath}
import postgres from ${JSON.stringify(pathToFileURL(Bun.resolveSync("postgres", import.meta.dir)).href)};
const args = process.argv.slice(2);
if (args.slice(0, 6).join(" ") !== "--lock-held-fd 9 exec -T postgres psql") process.exit(64);
const client = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const rows = await client.unsafe(args.at(-1));
  console.log(JSON.stringify(rows[0].coalesce));
} finally { await client.end(); }
`,
  { mode: 0o700 },
);

afterEach(async () => {
  await database.delete(actionPolicy).where(eq(actionPolicy.id, "current"));
});
afterAll(async () => {
  await database.$client.close();
  rmSync(directory, { recursive: true, force: true });
});

test.each(["absent", "equal", "permissive", "dry-run", "stale restrictive"])(
  "reviewed gate reads the policy that wins at boot: %s",
  async (mode) => {
    const row: ActionPolicy =
      mode === "permissive"
        ? { mode: "enforce", deny: [], allow: ["true"] }
        : mode === "dry-run"
          ? { ...reviewed, mode: "dry-run" }
          : mode === "stale restrictive"
            ? { ...reviewed, deny: [...reviewed.deny, "true"] }
            : reviewed;
    if (mode === "absent") await policyStore.reset();
    else await policyStore.set(row, "review-test");
    const result = Bun.spawnSync(
      [
        "sh",
        resolve(
          import.meta.dir,
          "../../deploy/netsfera/verify-reviewed-action-policy.sh",
        ),
        "--lock-held-fd",
        "9",
        artifact,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          OPENBOT_COMPOSE_HELPER: helper,
        },
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(
      ["absent", "equal"].includes(mode) ? 0 : 65,
    );
    const restarted = createPolicyStore(reviewed, database);
    expect(await restarted.load()).toBe(
      mode === "absent" ? "configuration" : "the database",
    );
    expect(restarted.get()).toEqual(row);
  },
);
