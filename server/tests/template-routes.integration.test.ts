import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { parseBotTemplate } from "../../shared/bot-template";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAgentRoutes } from "../src/agents/routes";
import { createAuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { createComponentStore } from "../src/components/store";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  botTemplates,
  components,
  deploymentPackages,
  mcpServers,
  mcpTools,
  pluginGrants,
  skills,
  templateImports,
  users,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { createTemplateInstaller } from "../src/templates/install";
import {
  createTemplateExport,
  createTemplateRoutes,
} from "../src/templates/routes";
import { createTemplateStore } from "../src/templates/store";

/**
 * The HTTP surface, against the real database and the real stores underneath it.
 *
 * Faked stores were the alternative and would have tested almost nothing that matters here: every
 * interesting property of these routes is a property of what they DELEGATE to — that a refused
 * document leaves exactly one row and no Bot, that a grant goes through the plugin store rather than
 * a second write, that a draft somebody else owns is answered as absent. A fake would have agreed
 * with whatever this file asserted.
 *
 * What is deliberately NOT re-tested here: the parser's refusal list, the packer's stripping and the
 * installer's transaction. Those have their own suites, and duplicating them through HTTP would make
 * this file the place they are maintained.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  { max: 2 },
);

const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
const auditStore = createAuditStore(database);
const pluginStore = createPluginStore({
  database,
  auditStore,
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => policy,
});
/**
 * The REAL component store, not a stub that cannot fail.
 *
 * `{ grant: async () => {} }` was here, and it is exactly why a green suite hid the bug this file
 * now covers: the only path that reaches `requireComponent` was tested against a fake that grants
 * anything, so granting a component no build has looked like a 200 rather than the throw it was.
 */
const componentStore = createComponentStore(database);
const templateStore = createTemplateStore(database);
const managedUrl = new URL("https://managed.example.com/agui");
const profileStore = createAgentProfileStore(database, managedUrl);
const installer = createTemplateInstaller({
  database,
  templateStore,
  pluginStore,
  auditStore,
  managedAgentAgUiUrl: managedUrl,
});

const suite = randomUUID().slice(0, 8);
const owner: AuthenticatedActor = {
  id: `owner_${suite}`,
  email: `owner-${suite}@openbot.test`,
  role: "user",
};
const stranger: AuthenticatedActor = {
  id: `stranger_${suite}`,
  email: `stranger-${suite}@openbot.test`,
  role: "user",
};
const administrator: AuthenticatedActor = {
  id: `admin_${suite}`,
  email: `admin-${suite}@openbot.test`,
  role: "admin",
};

const templateSlug = `renewal-desk-${suite}`;
const skillSlug = `check-renewal-${suite}`;
const connectorId = `acme-ledger-${suite}`;
const toolRef = `${connectorId}/search_files`;
/**
 * A component that is really in this build, scoped to the suite.
 *
 * `showBarChart` was hard-coded here and is in no build the test creates, so every component grant
 * this file made was a grant of a name that does not exist — which the stubbed store accepted. The
 * name is suffixed because `components.name` is the primary key and a shared one would make two
 * suites running at once fight over the same row.
 */
const componentName = `showAgeing${suite}`;

/**
 * The connectors and components the "inert ask" suite below moves in and out of the deployment.
 *
 * Declared up here so the teardown can take them whatever the tests did with them: two of them are
 * created after an import and one of them is destroyed after an import, which is the whole point —
 * a ledger row's status is a snapshot and the deployment underneath it moves.
 */
const lateConnector = `late-ledger-${suite}`;
const lateToolRef = `${lateConnector}/read_file_content`;
const lateComponent = `showLateChart${suite}`;
const goneConnector = `gone-ledger-${suite}`;
const goneToolRef = `${goneConnector}/search_files`;
const goneComponent = `showGoneChart${suite}`;
const lateSkill = `read-late-${suite}`;
const goneSkill = `read-gone-${suite}`;

/** Every Bot and draft this file made, so the teardown takes them and their grants with them. */
const createdAgents: string[] = [];
const packageIds: string[] = [];

function actorMiddleware(
  actor: AuthenticatedActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

/**
 * The app as it is mounted, one actor at a time.
 *
 * Built per actor rather than reading a header, because the guard is what decides who is asking and
 * a test that carried the identity in the request would be testing a guard this deployment does not
 * have.
 */
function appFor(
  actor: AuthenticatedActor,
  options: { components?: boolean } = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const requireUser = actorMiddleware(actor);
  app.route(
    "/api/templates",
    createTemplateRoutes(
      {
        templateStore,
        installer,
        auditStore,
        executor: database,
        managedAgent: true,
        grants: pluginStore,
        ...(options.components ? { components: componentStore } : {}),
      },
      requireUser,
      async (asking, botId) => (await profileStore.get(asking, botId)) !== null,
    ),
  );
  app.route(
    "/api/agents",
    createAgentRoutes(
      profileStore,
      requireUser,
      false,
      auditStore,
      new Set(),
      undefined,
      createTemplateExport({
        executor: database,
        templateStore,
        auditStore,
        plugins: pluginStore,
        managedAgentAgUiUrl: managedUrl,
      }),
    ),
  );
  return app;
}

function yamlFor(
  options: { slug?: string; roleDescription?: string; skill?: string } = {},
) {
  return `openbot_template: 1

template:
  slug: ${options.slug ?? templateSlug}
  version: "1.3"
  author: acme-revops
  summary: Chases overdue invoices and drafts the follow-up.

bot:
  name: Renewal Desk ${suite}
  title: Accounts Receivable
  role_description: >-
    ${options.roleDescription ?? "Chase overdue invoices and draft a follow-up for a person to send."}
  runtime: managed
  skills: [${options.skill ?? skillSlug}]

skills:
  - slug: ${options.skill ?? skillSlug}
    title: Check renewal risk
    summary: Pull the contract and the recent tickets for one account.
    instructions: >-
      Find the contract and read the renewal date from it. Name every document you used.
    tools:
      - ${toolRef}

requests:
  connectors:
    - id: ${connectorId}
      why: The invoice ledger export lives there.
      tools:
        - ref: ${toolRef}
          why: Find the ledger for one customer.
  components:
    - name: ${componentName}
      why: Ageing buckets.

boundary:
  shell: never
  files: none
  browser: read_only
  mcp: read_only
`;
}

/** Trail rows this suite's actors wrote, newest last. Scoped by actor, never by time. */
async function trail(eventType: string) {
  const rows = await database
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.eventType, eventType));
  return rows.filter((row) => {
    const actor = (row.payload as { actor?: unknown }).actor;
    return (
      actor === owner.email ||
      actor === stranger.email ||
      actor === administrator.email
    );
  });
}

async function makeBot(input: {
  id: string;
  name: string;
  ownerUserId: string | null;
  visibility: "public" | "private";
  packaged?: boolean;
}) {
  let packageId: string | null = null;
  if (input.packaged) {
    const [row] = await database
      .insert(deploymentPackages)
      .values({
        tenantId: `${input.id}-tenant`,
        sourcePath: "examples/fintech",
        checksum: "0".repeat(64),
      })
      .returning({ id: deploymentPackages.id });
    packageId = row?.id ?? null;
    if (packageId) packageIds.push(packageId);
  }
  await database.insert(agents).values({
    id: input.id,
    name: input.name,
    type: "remote_ag_ui",
    // The deployment's own address, which is what `create` writes for a Bot that runs in the box.
    // The packer needs it to read this as `managed` rather than as somebody's own server.
    configuration: { endpoint: managedUrl.toString() },
    ...(packageId ? { packageId } : {}),
  });
  await database.insert(agentProfiles).values({
    agentId: input.id,
    ownerUserId: input.ownerUserId,
    title: "Accounts Receivable",
    roleDescription:
      "Chase overdue invoices and draft the follow-up for a person to send.",
    avatarSeed: `seed-${suite}`,
    visibility: input.visibility,
  });
  createdAgents.push(input.id);
  return input.id;
}

const packagedBot = `agent_pkg_${suite}`;
const publicBot = `agent_pub_${suite}`;
const privateBot = `agent_priv_${suite}`;

beforeAll(async () => {
  await database
    .insert(users)
    .values([
      { id: owner.id, email: owner.email },
      { id: stranger.id, email: stranger.email },
      { id: administrator.id, email: administrator.email },
    ])
    .onConflictDoNothing();

  // Ownerless and public, which is what a package Bot is. Exporting one is deliberately allowed.
  await makeBot({
    id: packagedBot,
    name: `Risk Analyst ${suite}`,
    ownerUserId: null,
    visibility: "public",
    packaged: true,
  });
  // Somebody else's, and public: visible to everybody, manageable by nobody but its owner.
  await makeBot({
    id: publicBot,
    name: `Public Desk ${suite}`,
    ownerUserId: owner.id,
    visibility: "public",
  });
  await makeBot({
    id: privateBot,
    name: `Private Desk ${suite}`,
    ownerUserId: owner.id,
    visibility: "private",
  });

  // A connector that exists and advertises a tool, so the plan can report one ask as available and
  // the grant route has something real to delegate.
  await database
    .insert(mcpServers)
    .values({
      id: connectorId,
      title: "Acme Ledger",
      vendor: "Acme",
      url: "https://ledger.example.com/mcp",
      summary: "The invoice ledger.",
      docsUrl: "https://ledger.example.com/docs",
      provenance: "custom",
      addedBy: administrator.email,
    })
    .onConflictDoNothing();
  await database
    .insert(mcpTools)
    .values({
      serverId: connectorId,
      name: "search_files",
      description: "Find a ledger export.",
      inputSchema: {},
    })
    .onConflictDoNothing();

  // A component this build really has, so the component ask resolves as `available` and the grant
  // route has something the real store will accept.
  await database
    .insert(components)
    .values({
      name: componentName,
      title: "Ageing buckets",
      kind: "chart",
      draftDescription: "Draw the ageing buckets for one customer.",
      publishedDescription: "Draw the ageing buckets for one customer.",
      published: true,
    })
    .onConflictDoNothing();
});

/*
 * The pool goes back, and this is not tidiness.
 *
 * `bun test` runs every file in one process, so a pool left open here is held for the rest of the
 * suite. Enough files doing that and the deployment's own PostgreSQL runs out of connections
 * partway through a later file, which reads as the run dying somewhere unrelated rather than as a
 * connection limit. Every other integration test here closes; these did not, and CI died at a
 * different file on each run until they did.
 */
afterAll(async () => {
  if (createdAgents.length > 0) {
    await database.delete(agents).where(inArray(agents.id, createdAgents));
  }
  if (packageIds.length > 0) {
    await database
      .delete(deploymentPackages)
      .where(inArray(deploymentPackages.id, packageIds));
  }
  await database
    .delete(mcpServers)
    .where(inArray(mcpServers.id, [connectorId, lateConnector, goneConnector]));
  await database
    .delete(components)
    .where(
      inArray(components.name, [componentName, lateComponent, goneComponent]),
    );
  await database
    .delete(skills)
    .where(
      inArray(skills.slug, [skillSlug, `other-${suite}`, lateSkill, goneSkill]),
    );
  await database
    .delete(users)
    .where(inArray(users.id, [owner.id, stranger.id, administrator.id]));

  await database.$client.close();
});

describe("exporting a coworker", () => {
  test("a Bot you cannot see is not found, and a Bot you cannot manage is refused", async () => {
    const hidden = await appFor(stranger).request(
      `/api/agents/${privateBot}/template`,
      { method: "POST" },
    );
    // The store's read filter answers first, so a private Bot is absent rather than forbidden.
    expect(hidden.status).toBe(404);

    const visible = await appFor(stranger).request(
      `/api/agents/${publicBot}/template`,
      { method: "POST" },
    );
    // Visible to everybody and manageable by its owner: the honest answer is that this is refused,
    // not that it does not exist.
    expect(visible.status).toBe(403);
  });

  test("a package Bot exports for any signed-in person, and says what stayed behind", async () => {
    const response = await appFor(stranger).request(
      `/api/agents/${packagedBot}/template`,
      { method: "POST" },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      templateId: string;
      yaml: string;
      digest: string;
      stripped: string[];
    };

    // The draft is the stranger's, not the deployment's: exporting is authoring.
    const [draft] = await database
      .select()
      .from(botTemplates)
      .where(eq(botTemplates.id, body.templateId));
    expect(draft?.ownerUserId).toBe(stranger.id);
    expect(draft?.agentId).toBe(packagedBot);

    // The stripping is the interesting fact about an export, so the response names it.
    expect(body.stripped.some((line) => line.startsWith("agents.id"))).toBe(
      true,
    );
    expect(
      body.stripped.some((line) => line.startsWith("agents.package_id")),
    ).toBe(true);
    // A file, and one the parser will take back.
    expect(parseBotTemplate(body.yaml).bot.name).toBe(`Risk Analyst ${suite}`);

    const rows = await trail("template.exported");
    const recorded = rows.find((row) => row.targetId === packagedBot);
    expect(recorded).toBeDefined();
    const payload = recorded?.payload as Record<string, unknown>;
    expect(payload.digest).toBe(body.digest);
    // Never the prose. The role description is the substance of a template and it is not here.
    expect(JSON.stringify(payload)).not.toContain("Chase overdue invoices");
  });

  test("a second export does not overwrite the draft the author has been editing", async () => {
    const again = await appFor(stranger).request(
      `/api/agents/${packagedBot}/template`,
      { method: "POST" },
    );
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain(
      "already have a template draft",
    );
  });
});

describe("a draft belongs to whoever wrote it", () => {
  let draftId = "";

  beforeAll(async () => {
    const draft = await templateStore.createDraft(owner, {
      agentId: null,
      document: parseBotTemplate(yamlFor()),
    });
    draftId = draft.id;
  });

  test("the list is yours, and an administrator's is the deployment's", async () => {
    const mine = (await (
      await appFor(owner).request("/api/templates")
    ).json()) as { templates: { id: string; mine: boolean }[] };
    expect(mine.templates.some((row) => row.id === draftId)).toBe(true);
    expect(mine.templates.every((row) => row.mine)).toBe(true);

    const theirs = (await (
      await appFor(stranger).request("/api/templates")
    ).json()) as { templates: { id: string }[] };
    expect(theirs.templates.some((row) => row.id === draftId)).toBe(false);

    const all = (await (
      await appFor(administrator).request("/api/templates")
    ).json()) as { templates: { id: string; mine: boolean }[] };
    const seen = all.templates.find((row) => row.id === draftId);
    expect(seen).toBeDefined();
    // Ownership is reported separately from permission: an administrator sees it and it is not theirs.
    expect(seen?.mine).toBe(false);
  });

  test("somebody else's draft is absent rather than forbidden", async () => {
    for (const [method, path] of [
      ["PATCH", `/api/templates/${draftId}`],
      ["DELETE", `/api/templates/${draftId}`],
      ["GET", `/api/templates/${draftId}/file`],
    ] as const) {
      const response = await appFor(stranger).request(path, {
        method,
        ...(method === "PATCH"
          ? {
              body: JSON.stringify({ source: yamlFor() }),
              headers: { "content-type": "application/json" },
            }
          : {}),
      });
      expect(response.status).toBe(404);
    }
  });

  test("the file is served as a file", async () => {
    const response = await appFor(owner).request(
      `/api/templates/${draftId}/file`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/yaml");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${templateSlug}.openbot.yaml"`,
    );
    expect(parseBotTemplate(await response.text()).template.slug).toBe(
      templateSlug,
    );
  });

  test("an edit re-runs the parser and the secret scanner", async () => {
    const app = appFor(owner);
    const unparseable = await app.request(`/api/templates/${draftId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "openbot_template: 2\n" }),
    });
    expect(unparseable.status).toBe(400);
    expect((await unparseable.json()) as { reason: string }).toMatchObject({
      reason: "format_version",
    });

    const leaking = await app.request(`/api/templates/${draftId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: yamlFor({
          roleDescription:
            "Reach the ledger with sk-abcdefghijklmnopqrstuvwx and chase overdue invoices.",
        }),
      }),
    });
    expect(leaking.status).toBe(400);
    const refusal = (await leaking.json()) as {
      reason: string;
      field: string;
      error: string;
    };
    expect(refusal.reason).toBe("secret_shape");
    expect(refusal.field).toBe("bot.role_description");
    // The refusal is rendered, logged and audited, so it never quotes what it found.
    expect(refusal.error).not.toContain("sk-abcdefghijklmnopqrstuvwx");

    const edited = await app.request(`/api/templates/${draftId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: yamlFor({ roleDescription: "Chase the overdue ones only." }),
      }),
    });
    expect(edited.status).toBe(200);
    const [stored] = await database
      .select()
      .from(botTemplates)
      .where(eq(botTemplates.id, draftId));
    /*
     * Stored parsed rather than as the text somebody posted, which is what the schema chose and what
     * makes the digest stable across quoting. The honest cost is recorded there: an author's YAML
     * comments do not survive an edit.
     */
    const document = stored?.document as
      | { bot: { roleDescription: string } }
      | undefined;
    expect(document?.bot.roleDescription).toBe("Chase the overdue ones only.");
  });

  test("the owner can delete it", async () => {
    const response = await appFor(owner).request(`/api/templates/${draftId}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(204);
    expect(
      await database
        .select()
        .from(botTemplates)
        .where(eq(botTemplates.id, draftId)),
    ).toHaveLength(0);
  });
});

describe("reading a stranger's file", () => {
  test("a preview writes nothing and records nothing", async () => {
    const before = await trail("template.import_refused");
    const response = await appFor(owner).request("/api/templates/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: yamlFor({ slug: `preview-${suite}` }) }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      digest: string;
      plan: {
        connectors: { verdict: string; tools: { verdict: string }[] }[];
        components: { verdict: string }[];
        endpoint: { required: boolean };
      };
    };
    expect(body.digest).toHaveLength(64);
    // The connector exists here and advertises the tool, so the plan says the ask is satisfiable —
    // which is a statement about the deployment and not a grant.
    expect(body.plan.connectors[0]?.tools[0]?.verdict).toBe("available");
    // The component is in this build too, which is what makes the grant below a real one. The
    // `not_in_build` verdict has its own suite at the foot of this file, where it is the point.
    expect(body.plan.components[0]?.verdict).toBe("available");
    expect(body.plan.endpoint.required).toBe(false);

    // A preview is somebody reading. Nothing is written and nothing is filed as a refusal.
    expect(await trail("template.import_refused")).toHaveLength(before.length);
    expect(
      await database
        .select()
        .from(botTemplates)
        .where(eq(botTemplates.slug, `preview-${suite}`)),
    ).toHaveLength(0);
  });

  test("a refused document leaves exactly one row and creates nothing", async () => {
    const before = (await trail("template.import_refused")).length;
    const response = await appFor(owner).request("/api/templates/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // The two characters that make a stranger's prose read this deployment's environment.
        source: yamlFor({
          slug: `refused-${suite}`,
          roleDescription: `Chase invoices using \${KEY_ENCRYPTION_KEY}.`,
        }),
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; reason: string };
    // Both halves: the code a reader groups by, and the sentence the person is shown.
    expect(body.reason).toBe("interpolation");
    expect(body.error.length).toBeGreaterThan(0);

    const after = await trail("template.import_refused");
    expect(after).toHaveLength(before + 1);
    const payload = after[after.length - 1]?.payload as
      | { reason?: string; digest?: string }
      | undefined;
    expect(payload?.reason).toBe("interpolation");
    // Refused before anything was hashed, so there is no digest — and its absence is the fact.
    expect(payload?.digest).toBeUndefined();

    expect(
      await database
        .select()
        .from(templateImports)
        .where(eq(templateImports.slug, `refused-${suite}`)),
    ).toHaveLength(0);
  });
});

describe("installing", () => {
  let agentId = "";
  let importId = "";

  test("a digest that moved is 409, and nothing is created", async () => {
    const before = await database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, `Renewal Desk ${suite}`));

    const response = await appFor(owner).request("/api/templates/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: yamlFor(), digest: "b".repeat(64) }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()) as { reason: string }).toMatchObject({
      reason: "digest_moved",
    });

    const after = await database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, `Renewal Desk ${suite}`));
    expect(after).toHaveLength(before.length);

    /*
     * Refused after a clean parse, which is the case that gives `template.import_refused` a digest
     * at all: a document turned away by the parser never got as far as being hashed, and this one
     * did. The digest recorded is the one the file actually has, not the stale one that was sent.
     */
    const rows = await trail("template.import_refused");
    const payload = rows[rows.length - 1]?.payload as
      | { reason?: string; digest?: string; expected?: string }
      | undefined;
    expect(payload?.reason).toBe("digest_moved");
    expect(payload?.digest).toHaveLength(64);
    expect(payload?.expected).toBe("b".repeat(64));
  });

  test("the same file installs when the digest agrees", async () => {
    const source = yamlFor();
    const preview = (await (
      await appFor(owner).request("/api/templates/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
      })
    ).json()) as { digest: string };

    const response = await appFor(owner).request("/api/templates/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, digest: preview.digest, from: "paste" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      agentId: string;
      importId: string;
      requests: { kind: string; ref: string; status: string }[];
    };
    agentId = body.agentId;
    importId = body.importId;
    createdAgents.push(agentId);

    // The ask is recorded and nothing was granted: `requested` is a statement about a decision
    // nobody has made yet.
    expect(body.requests.find((row) => row.ref === toolRef)?.status).toBe(
      "requested",
    );
    expect(
      await database
        .select()
        .from(pluginGrants)
        .where(
          and(eq(pluginGrants.kind, "mcp"), eq(pluginGrants.agentId, agentId)),
        ),
    ).toHaveLength(0);
  });

  test("the provenance is readable by somebody who may use the Bot, and absent to anybody else", async () => {
    const mine = await appFor(owner).request(
      `/api/templates/imports/${agentId}`,
    );
    expect(mine.status).toBe(200);
    const body = (await mine.json()) as {
      import: { digest: string; authorClaim: string };
      requests: unknown[];
    };
    expect(body.import.authorClaim).toBe("acme-revops");
    expect(body.requests.length).toBeGreaterThan(0);

    // 404 rather than 403, matching GET /api/plugins/for/:agentId: an imported Bot is private to the
    // importer, and a distinguishable refusal is an oracle for what other people have installed.
    const theirs = await appFor(stranger).request(
      `/api/templates/imports/${agentId}`,
    );
    expect(theirs.status).toBe(404);
    expect(((await theirs.json()) as { error: string }).error).toBe(
      "There is no such Bot.",
    );
  });

  test("granting is an administrator's, and it goes through the grant store", async () => {
    const path = `/api/templates/imports/${agentId}/requests/mcp/${encodeURIComponent(toolRef)}/grant`;

    const refused = await appFor(owner).request(path, { method: "POST" });
    // The importer owns the Bot and still may not grant it a connector: MCP reaches another
    // company's system on this deployment's credential.
    expect(refused.status).toBe(403);

    const granted = await appFor(administrator).request(path, {
      method: "POST",
    });
    expect(granted.status).toBe(200);
    expect(
      ((await granted.json()) as { request: { status: string } }).request
        .status,
    ).toBe("granted");

    // Written by the existing store, with the administrator's own name on it rather than the
    // import's mark: a retraction must not take back what a person decided by hand.
    const [row] = await database
      .select()
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.agentId, agentId),
          eq(pluginGrants.kind, "mcp"),
          eq(pluginGrants.ref, toolRef),
        ),
      );
    expect(row?.grantedBy).toBe(administrator.email);

    const recorded = await trail("template.capability_granted");
    expect(recorded.some((event) => event.targetId === agentId)).toBe(true);
  });

  test("an ask this template never made, and a kind that is not one, are refused", async () => {
    const unknown = await appFor(administrator).request(
      `/api/templates/imports/${agentId}/requests/mcp/${encodeURIComponent(`${connectorId}/never_asked`)}/grant`,
      { method: "POST" },
    );
    // The route acts on the LEDGER. A ref the template never asked for has no row, so there is
    // nothing here that was consented to and nothing to approve.
    expect(unknown.status).toBe(404);

    const badKind = await appFor(administrator).request(
      `/api/templates/imports/${agentId}/requests/policy/anything/grant`,
      { method: "POST" },
    );
    // Checked at runtime, not only in the types: `kind` arrives in a path segment.
    expect(badKind.status).toBe(400);
  });

  test("a component ask cannot be granted where there is no component store", async () => {
    const response = await appFor(administrator).request(
      `/api/templates/imports/${agentId}/requests/component/${componentName}/grant`,
      { method: "POST" },
    );
    // Fail closed: the deployment cannot make the grant, so it says so rather than recording a
    // decision that satisfied nothing.
    expect(response.status).toBe(503);

    const withStore = await appFor(administrator, {
      components: true,
    }).request(
      `/api/templates/imports/${agentId}/requests/component/${componentName}/grant`,
      { method: "POST" },
    );
    expect(withStore.status).toBe(200);
  });

  test("declining records the no, and is also an administrator's", async () => {
    const path = `/api/templates/imports/${agentId}/requests/component/${componentName}/decline`;
    expect(
      (await appFor(stranger).request(path, { method: "POST" })).status,
    ).toBe(403);

    const response = await appFor(administrator).request(path, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { request: { status: string } }).request
        .status,
    ).toBe("declined");
    expect(
      (await trail("template.capability_declined")).some(
        (event) => event.targetId === agentId,
      ),
    ).toBe(true);
  });

  test("retraction is the owner's, and takes back only what the import gave", async () => {
    expect(importId.length).toBeGreaterThan(0);
    const refused = await appFor(stranger).request(
      `/api/templates/imports/${agentId}`,
      { method: "DELETE" },
    );
    // 404, not 403: telling a stranger that this Bot has an import to retract is the same oracle the
    // read above closes.
    expect(refused.status).toBe(404);

    const response = await appFor(owner).request(
      `/api/templates/imports/${agentId}`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      revoked: { kind: string; ref: string }[];
    };
    expect(body.revoked.map((row) => row.ref)).toEqual([skillSlug]);

    // The administrator's own grant survives, because it does not carry the import's mark.
    const held = await database
      .select()
      .from(pluginGrants)
      .where(eq(pluginGrants.agentId, agentId));
    expect(held.map((row) => row.ref)).toEqual([toolRef]);
  });
});

describe("the two asks that have no Grant button", () => {
  const otherSkill = `other-${suite}`;
  const bareConnector = `bare-ledger-${suite}`;
  const endpoint = `https://renewals-${suite}.example.com/agui`;
  let agentId = "";

  /**
   * A connector named with no tools under it, and a coworker that runs somewhere else.
   *
   * Both land in the ledger and neither is something an administrator can approve here: one is an
   * ask with nothing grantable behind it, the other was answered on the way in by whoever typed the
   * address. Installed for real rather than hand-inserted, so the rows are the shape the installer
   * actually writes.
   */
  const source = `openbot_template: 1

template:
  slug: remote-desk-${suite}
  summary: Runs somewhere else and names a connector with nothing under it.

bot:
  name: Remote Desk ${suite}
  title: Accounts Receivable
  role_description: >-
    Chase overdue invoices and draft the follow-up for a person to send.
  runtime: remote
  remote:
    auth_header: Authorization
    requires_key: false
    sends_conversation_to: renewals.example.com
  skills: [${otherSkill}]

skills:
  - slug: ${otherSkill}
    title: Read the contract
    summary: Pull the contract for one account.
    instructions: >-
      Find the contract and read the renewal date from it.
    tools: []

requests:
  connectors:
    - id: ${bareConnector}
      why: The ledger lives there, and nobody has written down which tools yet.
`;

  beforeAll(async () => {
    const preview = (await (
      await appFor(owner).request("/api/templates/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
      })
    ).json()) as { digest: string; plan: { endpoint: { required: boolean } } };
    expect(preview.plan.endpoint.required).toBe(true);

    const installed = await appFor(owner).request("/api/templates/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, digest: preview.digest, endpoint }),
    });
    expect(installed.status).toBe(201);
    agentId = ((await installed.json()) as { agentId: string }).agentId;
    createdAgents.push(agentId);
  });

  test("a connector with nothing under it says to add the connector", async () => {
    const response = await appFor(administrator).request(
      `/api/templates/imports/${agentId}/requests/mcp/${bareConnector}/grant`,
      { method: "POST" },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "is a connector, not a tool",
    );
    /*
     * The property the whole feature rests on: no optimistic grant anywhere. `store.grant` performs
     * no existence check, so a row written for an absent connector would be invisible on every
     * screen and would go live the day somebody added it.
     */
    expect(
      await database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.ref, bareConnector)),
    ).toHaveLength(0);
  });

  test("the address a coworker runs at is not a grant", async () => {
    const host = new URL(endpoint).host;
    const response = await appFor(administrator).request(
      `/api/templates/imports/${agentId}/requests/endpoint/${host}/grant`,
      { method: "POST" },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "answered by whoever imported it",
    );

    const declined = await appFor(administrator).request(
      `/api/templates/imports/${agentId}/requests/endpoint/${host}/decline`,
      { method: "POST" },
    );
    // Declining it is refused for the same reason. The row records that the importer answered, and
    // repointing a coworker is an edit of the Bot rather than a decision on this screen.
    expect(declined.status).toBe(400);
  });
});

/**
 * The consent screen's promise, kept at the moment somebody presses the button.
 *
 * An `unavailable` ask is told to a person twice — the consent screen says "Nothing will be granted
 * and nothing will be written", the Bot's profile says there is nothing yet to grant — and the route
 * used to check nothing but whether the ref contained a slash, so one administrator click wrote a
 * live `plugin_grants` row beside both of those sentences. Two properties are covered here and
 * neither is enough alone: the stored status is honoured, because a person was told that ask was
 * inert; and the two tables are read again at decision time, because that status is a snapshot from
 * resolve time and the deployment underneath it moves.
 */
describe("an ask this deployment could not satisfy stays inert", () => {
  let lateBot = "";
  let goneBot = "";

  const sourceFor = (input: {
    slug: string;
    name: string;
    skill: string;
    connector: string;
    ref: string;
    component: string;
  }) => `openbot_template: 1

template:
  slug: ${input.slug}
  summary: Names a connector and a component, and asks for a tool under each.

bot:
  name: ${input.name}
  title: Accounts Receivable
  role_description: >-
    Chase overdue invoices and draft the follow-up for a person to send.
  runtime: managed
  skills: [${input.skill}]

skills:
  - slug: ${input.skill}
    title: Read the contract
    summary: Pull the contract for one account.
    instructions: >-
      Find the contract and read the renewal date from it.
    tools: []

requests:
  connectors:
    - id: ${input.connector}
      why: The invoice ledger export lives there.
      tools:
        - ref: ${input.ref}
          why: Read the amounts and the due dates.
  components:
    - name: ${input.component}
      why: Ageing buckets.
`;

  async function install(source: string) {
    const preview = (await (
      await appFor(owner).request("/api/templates/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
      })
    ).json()) as { digest: string };
    const installed = await appFor(owner).request("/api/templates/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, digest: preview.digest }),
    });
    expect(installed.status).toBe(201);
    const body = (await installed.json()) as {
      agentId: string;
      requests: { kind: string; ref: string; status: string }[];
    };
    createdAgents.push(body.agentId);
    return body;
  }

  /** What the ledger says about one ask right now, read back rather than remembered. */
  async function statusOf(agentId: string, kind: string, ref: string) {
    const response = await appFor(owner).request(
      `/api/templates/imports/${agentId}`,
    );
    const body = (await response.json()) as {
      requests: { kind: string; ref: string; status: string }[];
    };
    return body.requests.find((row) => row.kind === kind && row.ref === ref)
      ?.status;
  }

  beforeAll(async () => {
    // Installed against a deployment that has neither, so both asks land as the plan resolved them:
    // the tool `unavailable` and the component `not_in_build`.
    const late = await install(
      sourceFor({
        slug: `late-desk-${suite}`,
        name: `Late Desk ${suite}`,
        skill: lateSkill,
        connector: lateConnector,
        ref: lateToolRef,
        component: lateComponent,
      }),
    );
    lateBot = late.agentId;
    expect(late.requests.find((row) => row.ref === lateToolRef)?.status).toBe(
      "unavailable",
    );
    expect(late.requests.find((row) => row.ref === lateComponent)?.status).toBe(
      "not_in_build",
    );

    // The other direction. Both are here while the template is read, so the ledger records
    // `requested` for each — and both are taken away afterwards, which is what the stored status
    // cannot see and the reason the decision re-reads.
    await database.insert(mcpServers).values({
      id: goneConnector,
      title: "Gone Ledger",
      vendor: "Acme",
      url: "https://gone.example.com/mcp",
      summary: "The ledger, while it lasted.",
      docsUrl: "https://gone.example.com/docs",
      provenance: "custom",
      addedBy: administrator.email,
    });
    await database.insert(mcpTools).values({
      serverId: goneConnector,
      name: "search_files",
      description: "Find a ledger export.",
      inputSchema: {},
    });
    await database.insert(components).values({
      name: goneComponent,
      title: "Ageing buckets",
      kind: "chart",
      draftDescription: "Draw the ageing buckets for one customer.",
      publishedDescription: "Draw the ageing buckets for one customer.",
      published: true,
    });

    const gone = await install(
      sourceFor({
        slug: `gone-desk-${suite}`,
        name: `Gone Desk ${suite}`,
        skill: goneSkill,
        connector: goneConnector,
        ref: goneToolRef,
        component: goneComponent,
      }),
    );
    goneBot = gone.agentId;
    expect(gone.requests.find((row) => row.ref === goneToolRef)?.status).toBe(
      "requested",
    );
    expect(gone.requests.find((row) => row.ref === goneComponent)?.status).toBe(
      "requested",
    );

    await database
      .delete(mcpServers)
      .where(eq(mcpServers.id, goneConnector))
      .execute();
    await database
      .delete(components)
      .where(eq(components.name, goneComponent))
      .execute();
  });

  test("a tool under a connector this deployment does not have is refused, and nothing is written", async () => {
    const response = await appFor(administrator).request(
      `/api/templates/imports/${lateBot}/requests/mcp/${encodeURIComponent(lateToolRef)}/grant`,
      { method: "POST" },
    );
    // The case the slash test missed. `google-drive/read_file_content` has a slash in it and is an
    // advertised Drive tool on some other deployment; that is not a reason to write a grant here.
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "was not connected here when this template was read",
    );
    expect(
      await database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.ref, lateToolRef)),
    ).toHaveLength(0);
    // And the row is still the undecided one the profile shows, not a decision nobody made.
    expect(await statusOf(lateBot, "mcp", lateToolRef)).toBe("unavailable");
  });

  test("connecting a server with that id afterwards does not make the inert ask grantable", async () => {
    await database.insert(mcpServers).values({
      id: lateConnector,
      title: "Late Ledger",
      vendor: "Acme",
      url: "https://late.example.com/mcp",
      summary: "Connected long after somebody read the template.",
      docsUrl: "https://late.example.com/docs",
      provenance: "custom",
      addedBy: administrator.email,
    });
    await database.insert(mcpTools).values({
      serverId: lateConnector,
      name: "read_file_content",
      description: "Read one document.",
      inputSchema: {},
    });

    const response = await appFor(administrator).request(
      `/api/templates/imports/${lateBot}/requests/mcp/${encodeURIComponent(lateToolRef)}/grant`,
      { method: "POST" },
    );
    /*
     * The half a live existence check alone would not cover. The tool exists this second, so the
     * only thing standing between the person who was told "nothing will be granted" and a grant is
     * the ledger's own status. Granting it is still possible — on the Plugins page, where nobody was
     * promised otherwise.
     */
    expect(response.status).toBe(400);
    expect(
      await database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.ref, lateToolRef)),
    ).toHaveLength(0);
    expect(await statusOf(lateBot, "mcp", lateToolRef)).toBe("unavailable");
  });

  test("a component no build here answers to is refused with the sentence the ledger already carries", async () => {
    const response = await appFor(administrator, { components: true }).request(
      `/api/templates/imports/${lateBot}/requests/component/${lateComponent}/grant`,
      { method: "POST" },
    );
    // 400 and a sentence, where an uncaught `ComponentNotFoundError` used to be an opaque 500 that
    // left the row undecided with nothing on the screen saying why.
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      `There is no component called ${lateComponent} in this build`,
    );
    expect(await statusOf(lateBot, "component", lateComponent)).toBe(
      "not_in_build",
    );
  });

  test("a tool the ledger still calls requested is re-checked, and refused once its connector is gone", async () => {
    const response = await appFor(administrator).request(
      `/api/templates/imports/${goneBot}/requests/mcp/${encodeURIComponent(goneToolRef)}/grant`,
      { method: "POST" },
    );
    /*
     * The half the stored status alone would not cover. This row resolved cleanly at import and says
     * `requested`; the connector left afterwards, and a grant written on the strength of that
     * snapshot would be invisible on every screen and would come back to life the day somebody
     * connected that id again.
     */
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "is not connected on this deployment",
    );
    expect(
      await database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.ref, goneToolRef)),
    ).toHaveLength(0);
    expect(await statusOf(goneBot, "mcp", goneToolRef)).toBe("requested");
  });

  test("a component that left the build after the import is refused rather than thrown", async () => {
    const response = await appFor(administrator, { components: true }).request(
      `/api/templates/imports/${goneBot}/requests/component/${goneComponent}/grant`,
      { method: "POST" },
    );
    // Same snapshot problem, arriving as a throw from `requireComponent` rather than as a verdict.
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      `There is no component called ${goneComponent} in this build`,
    );
    expect(await statusOf(goneBot, "component", goneComponent)).toBe(
      "requested",
    );
  });
});
