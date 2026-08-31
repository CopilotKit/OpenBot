import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  type BotTemplate,
  botTemplateDigest,
  parseBotTemplate,
} from "../../shared/bot-template";
import {
  type AuditEventInput,
  type AuditStore,
  createAuditStore,
} from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import { startPolicyListener } from "../src/computer/policy-listener";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "../src/computer/policy-store";
import type { ComputerProvider } from "../src/computer/provider";
import { createComputerRoutes } from "../src/computer/routes";
import { createDatabase } from "../src/db/client";
import {
  actionPolicy,
  agents,
  auditEvents,
  skills,
  templateBoundaries,
  users,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { BoundaryClauseRefusedError } from "../src/templates/boundary";
import { createTemplateInstaller } from "../src/templates/install";
import { createTemplateStore } from "../src/templates/store";

/**
 * The ceiling an imported Bot arrives with, from the file that described it to the action it stops.
 *
 * Three properties, and none of them are visible from a green typecheck.
 *
 * IT IS ENFORCED, which is the only reason to compile a boundary at all. A template that said
 * `shell: never` has to produce a refusal at the gateway, on the Bot it named and on no other. The
 * per-Bot half is the part that fails quietly if it is wrong: an unscoped clause would refuse the
 * whole deployment, and a clause scoped to the wrong Bot would refuse nothing while the trail said
 * the ceiling was applied.
 *
 * IT SURVIVES AN ADMINISTRATOR'S SAVE. `policyStore.set` replaces the whole `deny` array and the
 * Boundaries screen posts back a snapshot of what it last read, with no version column in between.
 * A generated clause stored in `action_policy.deny` would therefore be erased by the next unrelated
 * save on that screen — an imported Bot silently uncaged, with nothing anywhere saying it happened.
 * Separate storage is what makes that unrepresentable, so this file drives the real route rather
 * than asserting on the store it trusts.
 *
 * IT STOPS WHEN THE IMPORT IS RETRACTED, and only then. A ceiling that outlived its retraction would
 * be a coworker refused actions its owner has just been told it may take again.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, { max: 2 });

const auditStore = createAuditStore(database);
const pluginStore = createPluginStore({
  database,
  auditStore,
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => DEFAULT_ACTION_POLICY,
});
const templateStore = createTemplateStore(database);

const suite = randomUUID().slice(0, 8);
const importer = {
  id: `user_${suite}`,
  role: "user" as const,
  email: `importer-${suite}@openbot.local`,
};
const administrator = {
  id: `admin_${suite}`,
  role: "admin" as const,
  email: `admin-${suite}@openbot.local`,
};
const managedUrl = new URL("https://managed.example.com/agui");

const installer = createTemplateInstaller({
  database,
  templateStore,
  pluginStore,
  auditStore,
  managedAgentAgUiUrl: managedUrl,
});

/** Every Bot and skill this file makes, so the teardown takes their clauses with them. */
const created: string[] = [];
const touchedSlugs: string[] = [];

function yamlFor(
  slug: string,
  boundary = `boundary:
  shell: never
  files: read_only
  browser: read_only
  navigate_hosts:
    - billing.acme.example
  mcp: read_only`,
) {
  return `openbot_template: 1

template:
  slug: renewal-${slug}
  summary: Chases overdue invoices and drafts the follow-up.

bot:
  name: Renewal Desk ${slug}
  title: Accounts Receivable
  role_description: >-
    Chase overdue invoices. Draft a follow-up for a person to send, and name every
    document you used.
  runtime: managed
  skills: [${slug}]

skills:
  - slug: ${slug}
    title: Check renewal risk
    summary: Pull the contract and the recent tickets for one account.
    instructions: >-
      Find the contract and read the renewal date from it.
    tools:
      - google-drive/search_files

requests:
  connectors: []
  components: []

${boundary}
`;
}

/** One import, from a file nobody has installed before, with its own skill slug. */
async function importOne(
  name: string,
  boundary?: string,
): Promise<{ agentId: string; importId: string; template: BotTemplate }> {
  const slug = `${name}-${suite}`;
  touchedSlugs.push(slug);
  const template = parseBotTemplate(yamlFor(slug, boundary));
  const result = await installer.installBotTemplate({
    template,
    digest: await botTemplateDigest(template),
    actor: importer,
    source: "paste",
  });
  created.push(result.agentId);
  return {
    agentId: result.agentId,
    importId: result.imported.id,
    template,
  };
}

/**
 * A computer that answers every call, so a refusal is visibly the policy's and not the network's.
 *
 * `calls` is what reached it. The property under test is that a refused command never appears there:
 * a boundary that refuses after the command has run is not a boundary.
 */
function fakeComputer() {
  const calls: string[] = [];
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-bot",
    locate: async () => "http://agent-computer:4100",
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    list: async () => [],
  };
  const fetchImpl = (async (url: string) => {
    calls.push(new URL(url).pathname);
    return Response.json({
      command: "ls",
      exitCode: 0,
      output: "",
      truncated: false,
      timedOut: false,
    });
  }) as unknown as typeof fetch;
  return { provider, fetchImpl, calls };
}

/** The gateway the deployment runs, reading the policy the way `index.ts` wires it. */
function computerFor(policyStore: ReturnType<typeof createPolicyStore>) {
  const { provider, fetchImpl, calls } = fakeComputer();
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  const gateway = createComputerGateway({
    provider,
    fetchImpl,
    auditStore: store,
    policy: () => policyStore.get(),
  });
  return { gateway, calls, rows };
}

/** The Boundaries screen, driven for real: the same routes, the same store, the same snapshot. */
function boundariesScreen(policyStore: ReturnType<typeof createPolicyStore>) {
  const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", administrator);
    await next();
  };
  const routes = createComputerRoutes(
    {} as never,
    policyStore,
    asActor,
    async () => false,
  );
  return new Hono<{ Variables: AppVariables }>().route(
    "/api/computers",
    routes,
  );
}

/**
 * Wait for the other server to catch up.
 *
 * NOTIFY is delivered on commit and read on a second connection, so the update lands a moment after
 * the write returns. Polled rather than slept, so the test is not a fixed delay that is either flaky
 * or slow, and it fails on the assertion below rather than on the timeout.
 */
async function until(condition: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function liveClauses(agentId: string) {
  return database
    .select()
    .from(templateBoundaries)
    .where(
      and(
        eq(templateBoundaries.agentId, agentId),
        isNull(templateBoundaries.removedAt),
      ),
    );
}

beforeAll(async () => {
  await database
    .insert(users)
    .values([
      { id: importer.id, email: importer.email },
      { id: administrator.id, email: administrator.email },
    ])
    .onConflictDoNothing();
  await database.delete(actionPolicy).where(eq(actionPolicy.id, "current"));
});

/*
 * The pool goes back, after the cleanup queries and not before.
 *
 * `bun test` runs every file in one process, so a pool left open here is held for the rest of the
 * run and the totals add up rather than take turns. Enough files doing that and PostgreSQL runs out
 * of connections partway through a later file, which reads as the run dying somewhere unrelated.
 */
afterAll(async () => {
  if (created.length > 0) {
    await database.delete(agents).where(inArray(agents.id, created));
  }
  if (touchedSlugs.length > 0) {
    await database.delete(skills).where(inArray(skills.slug, touchedSlugs));
  }
  await database.delete(actionPolicy).where(eq(actionPolicy.id, "current"));
  await database
    .delete(users)
    .where(inArray(users.id, [importer.id, administrator.id]));

  await database.$client.close();
});

describe("the ceiling an import writes", () => {
  test("lands in template_boundaries, scoped to the Bot, and never in action_policy", async () => {
    const { agentId, importId } = await importOne("scoped");

    const clauses = await liveClauses(agentId);
    expect(clauses.map((row) => row.sourceKey).sort()).toEqual([
      "browser",
      "files",
      "mcp",
      "navigate_hosts",
      "shell",
    ]);
    // Every clause names the Bot first. The leading conjunct is what keeps a clause that throws from
    // refusing every action in the deployment, so it is asserted rather than assumed.
    for (const clause of clauses) {
      expect(clause.expression.startsWith(`bot.id == "${agentId}" && (`)).toBe(
        true,
      );
      expect(clause.importId).toBe(importId);
    }

    // The deployment's own policy is untouched, which is the whole reason for a second table.
    const rows = await database
      .select()
      .from(actionPolicy)
      .where(eq(actionPolicy.id, "current"));
    expect(rows).toEqual([]);
  });

  test("is on the trail verbatim, so it can be compared with the consent screen", async () => {
    const { agentId } = await importOne("trail");

    const [row] = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetId, agentId),
          eq(auditEvents.eventType, "template.boundary_applied"),
        ),
      );
    const clauses = (await liveClauses(agentId)).map(
      (entry) => entry.expression,
    );
    expect(row?.payload.clauses).toEqual(expect.arrayContaining(clauses));
  });

  test("writes nothing at all when the author's ceiling forbids nothing", async () => {
    // A permissive line is an absence of clauses rather than a row saying "may". A row claiming a
    // template conferred a shell would read on the Boundaries screen as a grant, and this feature
    // grants nothing.
    const { agentId } = await importOne(
      "permissive",
      `boundary:
  shell: permitted
  files: read_write
  browser: full
  mcp: read_write`,
    );

    expect(await liveClauses(agentId)).toEqual([]);
    const trail = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetId, agentId),
          eq(auditEvents.eventType, "template.boundary_applied"),
        ),
      );
    expect(trail).toEqual([]);
  });
});

describe("what the gateway does with it", () => {
  test("refuses the imported Bot a shell, and refuses no other Bot", async () => {
    const { agentId } = await importOne("shell");

    const policyStore = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    await policyStore.load();
    const { gateway, calls } = computerFor(policyStore);

    await expect(
      gateway.runCommand(agentId, { id: importer.id }, { command: "ls" }),
    ).rejects.toThrow(ActionRefusedError);
    // Decided before the effect: a refused command must never reach the computer.
    expect(calls).toEqual([]);

    /*
     * The same command, on a Bot nobody imported.
     *
     * This is the assertion the scoping exists for. cel-js short-circuits `&&`, so a clause whose
     * leading conjunct did not name the Bot would reach its tail for every coworker on the
     * deployment — and the tail names `intent`, which throws when it is unbound, and a throwing deny
     * counts as a match. The failure would be a deployment-wide outage that looks like a working
     * ceiling.
     */
    await gateway.runCommand(
      `agent_hand_made_${suite}`,
      { id: importer.id },
      { command: "ls" },
    );
    expect(calls).toEqual(["/exec"]);
  });

  test("a server that starts up afterwards enforces it too", async () => {
    // Another server is a second store on the same database, the way the fan-out test simulates one.
    // Reading back through the store that wrote it would only prove it remembers what it was told.
    const { agentId } = await importOne("fanout");

    const otherServer = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    await otherServer.load();

    expect(
      otherServer.get().deny.some((expression) => expression.includes(agentId)),
    ).toBe(true);
  });

  test("a server already running hears about it, and hears about the retraction", async () => {
    /*
     * The half a restart cannot cover, and the reason an import announces at all.
     *
     * The clauses are held in memory because the policy is asked on every action, so an import that
     * only wrote rows would apply on no server until each of them restarted — and a retraction would
     * go on refusing actions its owner has been told are allowed again, on some servers and not
     * others. That is a boundary that looks like it works, which is worse than one that plainly does
     * not.
     */
    const otherServer = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    await otherServer.load();
    const listener = await startPolicyListener(databaseUrl, otherServer);

    try {
      const { agentId } = await importOne("announced");
      const names = (expression: string) => expression.includes(agentId);

      await until(() => otherServer.get().deny.some(names));
      expect(otherServer.get().deny.some(names)).toBe(true);

      await installer.retractTemplateImport({ actor: importer, agentId });

      await until(() => !otherServer.get().deny.some(names));
      expect(otherServer.get().deny.some(names)).toBe(false);
    } finally {
      await listener.stop();
    }
  });
});

describe("an administrator saving an unrelated rule", () => {
  test("does not erase the clause, and does not adopt it either", async () => {
    const { agentId } = await importOne("snapshot");

    const policyStore = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    await policyStore.load();
    const screen = boundariesScreen(policyStore);

    // Exactly what the screen does: read the boundary, add a rule, post back the whole thing.
    const read = await screen.request("http://t/api/computers/policy");
    const shown = (await read.json()) as {
      policy: { mode: string; deny: string[]; allow: string[] };
    };

    /*
     * THE SCREEN IS SERVED WHAT AN ADMINISTRATOR WROTE, NEVER WHAT IS IN FORCE.
     *
     * This asserted the opposite once, and the opposite is what shipped for an afternoon: the route
     * answered with the composed policy, so a clause an import applied appeared in the list the
     * screen edits, with a Remove button beside it. `set` filters those back out, so pressing it
     * saved successfully, changed nothing, and left the rule enforced with nothing on screen saying
     * why. The clauses are shown on the same page in their own read-only group; they are not in this
     * array.
     */
    expect(shown.policy.deny.some((rule) => rule.includes(agentId))).toBe(
      false,
    );
    expect(shown.policy.deny).toEqual([]);

    const operatorRule = 'contains(element.name, "submit")';
    const saved = await screen.request("http://t/api/computers/policy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...shown.policy,
        deny: [...shown.policy.deny, operatorRule],
      }),
    });
    expect(saved.status).toBeLessThan(300);

    /*
     * The saved row holds the administrator's rule and nothing else.
     *
     * If the generated clause had been written here it would become an operator rule: retraction
     * would no longer remove it, and the next save from a server whose copy was a moment stale would
     * drop it for good. Both halves of that are silent.
     */
    const [row] = await database
      .select()
      .from(actionPolicy)
      .where(eq(actionPolicy.id, "current"));
    expect(row?.deny).toEqual([operatorRule]);

    // And it is still enforced, which is the point of not having stored it.
    const { gateway } = computerFor(policyStore);
    await expect(
      gateway.runCommand(agentId, { id: importer.id }, { command: "ls" }),
    ).rejects.toThrow(ActionRefusedError);

    await database.delete(actionPolicy).where(eq(actionPolicy.id, "current"));
  });
});

describe("retraction", () => {
  test("stops the clause being enforced, and says when it stopped", async () => {
    const { agentId, importId } = await importOne("retract");

    const policyStore = createPolicyStore(DEFAULT_ACTION_POLICY, database);
    await policyStore.load();
    const { gateway, calls } = computerFor(policyStore);
    await expect(
      gateway.runCommand(agentId, { id: importer.id }, { command: "ls" }),
    ).rejects.toThrow(ActionRefusedError);

    const outcome = await installer.retractTemplateImport({
      actor: importer,
      agentId,
    });
    expect(outcome.boundaries.length).toBeGreaterThan(0);

    // What the announcement makes every server do. Held in memory, so nothing changes until it does.
    await policyStore.refresh();
    await gateway.runCommand(agentId, { id: importer.id }, { command: "ls" });
    expect(calls).toEqual(["/exec"]);

    /*
     * Retired rather than deleted. "This Bot was never bounded" and "somebody took this Bot's bound
     * off" must not be the same database state: one is a template that asked for nothing, the other
     * is an act a person performed and can be asked about.
     */
    expect(await liveClauses(agentId)).toEqual([]);
    const all = await templateStore.boundariesFor(importId);
    expect(all.length).toBeGreaterThan(0);
    for (const row of all) expect(row.removedAt).toBeInstanceOf(Date);

    const [trail] = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetId, agentId),
          eq(auditEvents.eventType, "template.boundary_removed"),
        ),
      );
    expect(trail?.payload.clauses).toEqual(outcome.boundaries);
  });
});

describe("a clause that would not behave like a rule", () => {
  test("never reaches the table, whichever way it is offered", async () => {
    const { agentId, importId } = await importOne("malformed");
    const before = (await liveClauses(agentId)).length;

    for (const expression of [
      // Unparseable: cel-js throws, and a throwing deny expression counts as a match, so this row
      // would refuse every action this Bot ever attempted rather than the one it names.
      `bot.id == "${agentId}" && (intent == "`,
      // Parseable and still fatal: an identifier nothing binds throws the same way, and only for the
      // Bot named — which is the version that survives a review because it looks like a rule.
      `bot.id == "${agentId}" && (whatever == "run_command")`,
      // Answers, but not with a verdict. A deny list needs true or false.
      `bot.id == "${agentId}" && ("run_command")`,
    ]) {
      await expect(
        templateStore.recordBoundaries([
          { importId, agentId, expression, sourceKey: "shell" },
        ]),
      ).rejects.toThrow(BoundaryClauseRefusedError);
    }

    expect((await liveClauses(agentId)).length).toBe(before);
  });
});
