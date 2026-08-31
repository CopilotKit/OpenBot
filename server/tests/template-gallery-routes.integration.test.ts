import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  botTemplateDigest,
  parseBotTemplate,
  serializeBotTemplate,
} from "../../shared/bot-template";
import { createAuditStore } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import { agents, skills, users } from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import {
  createTemplateCatalogue,
  type TemplateCatalogue,
  type TemplateInstallers,
} from "../src/templates/catalogue";
import { createTemplateInstaller } from "../src/templates/install";
import {
  createTemplateAdminRoutes,
  createTemplateRoutes,
} from "../src/templates/routes";
import { createTemplateStore } from "../src/templates/store";

/**
 * The gallery and the administrator's half of the template surface, over the real catalogue and the
 * real database.
 *
 * TWO PROPERTIES ARE WHAT THIS FILE IS FOR, and everything else in it is scaffolding around them.
 *
 * The first is that an install `from: "gallery"` reads the document out of the CATALOGUE and never
 * out of the request. A posted document would make the provenance column a claim the browser gets
 * to write, and that column is what an administrator reads on the Templates screen when deciding
 * whether a coworker came from somewhere this deployment vouches for. The test that proves it posts
 * one document and names another, and asserts the one that was named is the one that arrived.
 *
 * The second is the round trip the gallery flow silently depends on. The consent screen previews the
 * YAML this surface serialises, so the digest it is shown is taken over `parse(serialize(document))`
 * — while the install compares against the digest the catalogue computed over its own parse of the
 * file on disk. If serialising were lossy the two would differ and every gallery install would 409
 * with nothing wrong. It is asserted for each shipped template rather than reasoned about.
 *
 * The catalogue is the REAL one over `examples/templates`, not a fixture. A stub would have agreed
 * with whatever this file claimed about how a slug resolves, and the shipped templates are exactly
 * the documents a fresh deployment's first import comes from.
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
const templateStore = createTemplateStore(database);
const managedUrl = new URL("https://managed.example.com/agui");
const installer = createTemplateInstaller({
  database,
  templateStore,
  pluginStore,
  auditStore,
  managedAgentAgUiUrl: managedUrl,
});

const suite = randomUUID().slice(0, 8);
const person: AuthenticatedActor = {
  id: `person_${suite}`,
  email: `person-${suite}@openbot.test`,
  role: "user",
};
const administrator: AuthenticatedActor = {
  id: `admin_${suite}`,
  email: `admin-${suite}@openbot.test`,
  role: "admin",
};

/** The repository the reference catalogue lives in, allowlisted for the registration tests. */
const ALLOWED = "jerelvelarde/awesome-openbot-templates";
const SHA = "a".repeat(40);

const createdAgents: string[] = [];

function actorMiddleware(
  actor: AuthenticatedActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

/**
 * A catalogue over the templates this repository actually ships.
 *
 * `fetch` is injected and refuses, so a test that accidentally reached the network would fail rather
 * than pass slowly against GitHub. Nothing here registers a source that is ever fetched from; the
 * source tests assert the registration rules, which are decided before a URL is built.
 */
function catalogueFor(floor: TemplateInstallers = "anyone"): TemplateCatalogue {
  return createTemplateCatalogue({
    directory: `${import.meta.dir}/../../examples/templates`,
    allowedSources: new Set([ALLOWED]),
    installerFloor: floor,
    fetch: async () => {
      throw new Error("No test may reach the network.");
    },
  });
}

/**
 * The app as it is mounted, one actor and one catalogue at a time.
 *
 * The catalogue is a parameter rather than a module-level singleton because `installers` is state it
 * holds for the life of the process: a test that raised the setting would otherwise decide what the
 * next test's install is allowed to do, through a dependency neither of them names.
 */
function appFor(actor: AuthenticatedActor, catalogue: TemplateCatalogue) {
  const app = new Hono<{ Variables: AppVariables }>();
  const requireUser = actorMiddleware(actor);
  const deps = {
    templateStore,
    installer,
    auditStore,
    executor: database,
    managedAgent: true,
    grants: pluginStore,
    gallery: { catalogue, installerFloor: catalogue.installers() },
  };
  app.route(
    "/api/templates",
    createTemplateRoutes(deps, requireUser, async () => true),
  );
  app.route(
    "/api/admin/templates",
    createTemplateAdminRoutes(deps, requireUser),
  );
  return app;
}

type GalleryCard = {
  slug: string;
  digest: string;
  name: string;
  author: string | null;
  summary: string;
  connectors: string[];
  origin: { kind: string; filename?: string };
};

async function gallery(
  actor: AuthenticatedActor,
  catalogue: TemplateCatalogue,
) {
  const response = await appFor(actor, catalogue).request(
    "/api/templates/gallery",
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      templates: GalleryCard[];
      skipped: { where: string; reason: string }[];
      installers: TemplateInstallers;
    },
  };
}

beforeAll(async () => {
  await database
    .insert(users)
    .values([
      { id: person.id, email: person.email },
      { id: administrator.id, email: administrator.email },
    ])
    .onConflictDoNothing();
});

describe("the gallery", () => {
  test("lists the templates this image ships, as cards rather than documents", async () => {
    const { status, body } = await gallery(person, catalogueFor());
    expect(status).toBe(200);
    expect(body.templates.length).toBeGreaterThanOrEqual(3);

    const research = body.templates.find(
      (card) => card.slug === "research-desk",
    );
    expect(research).toBeDefined();
    expect(research?.name).toBe("Research Desk");
    // The author is a CLAIM, and it travels as one rather than being resolved into anything.
    expect(research?.author).toBe("openbot");
    expect(research?.origin.kind).toBe("directory");
    expect(research?.digest).toMatch(/^[0-9a-f]{64}$/);

    /*
     * NO PROSE ON A CARD. A gallery card is where somebody decides whether to open a template; the
     * consent screen is where they read what a stranger wrote, under a heading saying so. A
     * `roleDescription` leaking onto this payload would put an untrusted paragraph on a screen with
     * no such heading, which is the failure the whole consent flow exists to prevent.
     */
    expect(JSON.stringify(body.templates)).not.toContain("roleDescription");
    expect(JSON.stringify(body.templates)).not.toContain("instructions");
  });

  test("names what it could not read instead of going blank", async () => {
    const { body } = await gallery(
      person,
      createTemplateCatalogue({
        directory: `${import.meta.dir}/no-such-directory`,
        allowedSources: new Set(),
        installerFloor: "anyone",
      }),
    );
    expect(body.templates).toEqual([]);
    expect(body.skipped.length).toBeGreaterThan(0);
  });

  test("serves one template as the file it is, and the file round-trips", async () => {
    const catalogue = catalogueFor();
    const listed = (await gallery(person, catalogue)).body.templates;
    for (const card of listed) {
      const response = await appFor(person, catalogue).request(
        `/api/templates/gallery/${card.slug}`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { yaml: string; digest: string };
      expect(body.yaml).toContain("openbot_template: 1");
      /*
       * The property the gallery install depends on: what the consent screen previews hashes to the
       * digest the catalogue computed. If this ever fails, every gallery install answers 409 and
       * nothing about the file is wrong.
       */
      expect(await botTemplateDigest(parseBotTemplate(body.yaml))).toBe(
        body.digest,
      );
      expect(body.digest).toBe(card.digest);
    }
  });

  test("answers 404 for a slug it does not have", async () => {
    const response = await appFor(person, catalogueFor()).request(
      "/api/templates/gallery/no-such-template",
    );
    expect(response.status).toBe(404);
  });

  test("has no way to publish into it", async () => {
    const response = await appFor(administrator, catalogueFor()).request(
      "/api/templates/gallery",
      { method: "POST", body: "{}" },
    );
    // 404 rather than 405: nothing is registered at that method, which is the point.
    expect(response.status).toBe(404);
  });
});

describe("installing from the gallery", () => {
  async function install(
    actor: AuthenticatedActor,
    catalogue: TemplateCatalogue,
    body: Record<string, unknown>,
  ) {
    const response = await appFor(actor, catalogue).request(
      "/api/templates/install",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const parsed = (await response.json()) as Record<string, unknown>;
    if (typeof parsed.agentId === "string") createdAgents.push(parsed.agentId);
    return { status: response.status, body: parsed };
  }

  test("reads the document from the catalogue and ignores the one posted", async () => {
    const catalogue = catalogueFor();
    const entry = await catalogue.fromDirectory("research-desk");
    if (!entry) throw new Error("research-desk is not in examples/templates");

    /*
     * A DIFFERENT DOCUMENT IN THE BODY, and one that would be perfectly acceptable on its own: the
     * competitor-watch template, renamed. If the route parsed what was posted, the Bot that arrived
     * would be that one under research-desk's provenance — a file nobody consented to, filed as one
     * that came from the deployment's own gallery.
     */
    const other = await catalogue.fromDirectory("competitor-watch");
    if (!other)
      throw new Error("competitor-watch is not in examples/templates");

    const { status, body } = await install(person, catalogue, {
      source: serializeBotTemplate(other.document),
      digest: entry.digest,
      from: "gallery",
      sourceRef: "research-desk",
    });

    expect(status).toBe(201);
    expect(body.slug).toBe("research-desk");
    expect(body.digest).toBe(entry.digest);
  });

  test("refuses a digest that no longer names the gallery entry", async () => {
    const { status, body } = await install(person, catalogueFor(), {
      digest: "b".repeat(64),
      from: "gallery",
      sourceRef: "research-desk",
    });
    expect(status).toBe(409);
    expect(body.reason).toBe("digest_moved");
  });

  test("refuses a slug the gallery does not offer", async () => {
    const { status } = await install(person, catalogueFor(), {
      digest: "b".repeat(64),
      from: "gallery",
      sourceRef: "no-such-template",
    });
    expect(status).toBe(404);
  });

  test("still takes a pasted file, which needs no gallery at all", async () => {
    const catalogue = catalogueFor();
    const entry = await catalogue.fromDirectory("ticket-triage");
    if (!entry) throw new Error("ticket-triage is not in examples/templates");
    const { status, body } = await install(person, catalogue, {
      source: serializeBotTemplate(entry.document),
      digest: entry.digest,
      from: "paste",
    });
    expect(status).toBe(201);
    expect(body.slug).toBe("ticket-triage");
  });

  test("an admin-only deployment refuses an ordinary person and takes an administrator", async () => {
    const catalogue = catalogueFor("admin");
    const entry = await catalogue.fromDirectory("competitor-watch");
    if (!entry)
      throw new Error("competitor-watch is not in examples/templates");
    const request = {
      digest: entry.digest,
      from: "gallery",
      sourceRef: "competitor-watch",
    };

    const refused = await install(person, catalogue, request);
    expect(refused.status).toBe(403);

    /*
     * READING IS STILL ALLOWED. Somebody who may not install has every reason to read a template and
     * hand the URL to somebody who can, and a gate on the preview would only mean the decision gets
     * made from a screenshot.
     */
    const preview = await appFor(person, catalogue).request(
      "/api/templates/preview",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: serializeBotTemplate(entry.document) }),
      },
    );
    expect(preview.status).toBe(200);

    const allowed = await install(administrator, catalogue, request);
    expect(allowed.status).toBe(201);
  });
});

describe("the deployment's own settings", () => {
  test("an ordinary person reaches none of it", async () => {
    const catalogue = catalogueFor();
    const app = appFor(person, catalogue);
    for (const [path, method] of [
      ["/api/admin/templates/settings", "GET"],
      ["/api/admin/templates/settings", "PUT"],
      ["/api/admin/templates/sources", "POST"],
      ["/api/admin/templates/sources", "DELETE"],
      ["/api/admin/templates/imports", "GET"],
      ["/api/templates/boundaries", "GET"],
    ] as const) {
      const response = await app.request(path, {
        method,
        ...(method === "GET"
          ? {}
          : { headers: { "content-type": "application/json" }, body: "{}" }),
      });
      expect(`${method} ${path}: ${response.status}`).toBe(
        `${method} ${path}: 403`,
      );
    }
  });

  test("reports the setting, the floor under it and the allowlist", async () => {
    const response = await appFor(administrator, catalogueFor()).request(
      "/api/admin/templates/settings",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      installers: string;
      floor: string;
      allowedSources: string[];
      sources: unknown[];
    };
    expect(body.installers).toBe("anyone");
    expect(body.floor).toBe("anyone");
    expect(body.allowedSources).toEqual([ALLOWED]);
    expect(body.sources).toEqual([]);
  });

  test("refuses a value it does not recognise rather than reading it as the nearest one", async () => {
    const catalogue = catalogueFor();
    const app = appFor(administrator, catalogue);
    const response = await app.request("/api/admin/templates/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installers: "Admin" }),
    });
    expect(response.status).toBe(400);
    // The value STILL IN FORCE, so the screen puts the control back rather than showing a choice
    // nobody made.
    expect((await response.json()).installers).toBe("anyone");
    expect(catalogue.installers()).toBe("anyone");
  });

  test("raises the setting, and refuses to lower it below the environment's floor", async () => {
    const catalogue = catalogueFor();
    const app = appFor(administrator, catalogue);

    const raised = await app.request("/api/admin/templates/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installers: "admin" }),
    });
    expect(raised.status).toBe(200);
    expect(catalogue.installers()).toBe("admin");

    const floored = appFor(administrator, catalogueFor("admin"));
    const lowered = await floored.request("/api/admin/templates/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installers: "anyone" }),
    });
    expect(lowered.status).toBe(400);
    expect((await lowered.json()).installers).toBe("admin");
  });
});

describe("pinned sources", () => {
  async function post(catalogue: TemplateCatalogue, body: unknown) {
    const response = await appFor(administrator, catalogue).request(
      "/api/admin/templates/sources",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() };
  }

  test("registers a repository on the allowlist, pinned to a commit", async () => {
    const catalogue = catalogueFor();
    const { status, body } = await post(catalogue, {
      handle: ALLOWED,
      sha: SHA,
    });
    expect(status).toBe(201);
    expect(body.source.id).toBe(ALLOWED);
    expect(body.source.sha).toBe(SHA);
    expect(catalogue.sources()).toHaveLength(1);
  });

  test("refuses a repository the environment did not permit", async () => {
    const { status, body } = await post(catalogueFor(), {
      handle: "somebody/else",
      sha: SHA,
    });
    expect(status).toBe(400);
    expect(body.reason).toBe("not_allowlisted");
  });

  test("refuses a ref that is not a full commit sha", async () => {
    const { status, body } = await post(catalogueFor(), {
      handle: ALLOWED,
      sha: "main",
    });
    expect(status).toBe(400);
    expect(body.reason).toBe("bad_ref");
  });

  test("forgets a source, and says so when there is nothing to forget", async () => {
    const catalogue = catalogueFor();
    await post(catalogue, { handle: ALLOWED, sha: SHA });
    const app = appFor(administrator, catalogue);

    const forgotten = await app.request("/api/admin/templates/sources", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ALLOWED }),
    });
    expect(forgotten.status).toBe(204);
    expect(catalogue.sources()).toEqual([]);

    const again = await app.request("/api/admin/templates/sources", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ALLOWED }),
    });
    expect(again.status).toBe(404);
  });
});

describe("what this deployment has imported", () => {
  test("lists every import with its ledger and its ceiling, and no document", async () => {
    const catalogue = catalogueFor();
    const entry = await catalogue.fromDirectory("research-desk");
    if (!entry) throw new Error("research-desk is not in examples/templates");

    const installed = await appFor(person, catalogue).request(
      "/api/templates/install",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          digest: entry.digest,
          from: "gallery",
          sourceRef: "research-desk",
        }),
      },
    );
    expect(installed.status).toBe(201);
    const agentId = ((await installed.json()) as { agentId: string }).agentId;
    createdAgents.push(agentId);

    const response = await appFor(administrator, catalogue).request(
      "/api/admin/templates/imports",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      imports: {
        agentId: string;
        agentName: string;
        source: string;
        authorClaim: string | null;
        importedBy: string;
        requests: unknown[];
        boundaries: unknown[];
      }[];
    };

    const mine = body.imports.find((row) => row.agentId === agentId);
    expect(mine).toBeDefined();
    expect(mine?.source).toBe("gallery");
    expect(mine?.authorClaim).toBe("openbot");
    expect(mine?.importedBy).toBe(person.email);
    expect(mine?.agentName).toBe("Research Desk");
    // The ledger travels; the document does not. A roster that carried every template would cost as
    // much to open as opening every file on it.
    expect(Array.isArray(mine?.requests)).toBe(true);
    expect(JSON.stringify(mine)).not.toContain("roleDescription");

    /*
     * The author's own sentence and the compiled clause, asserted here rather than through the
     * screen that shows them.
     *
     * They are what the administrator reads while deciding, so something has to hold them down. The
     * screen renders them inside a dialog, and a dialog is a portal: whether one mounts depends on
     * which file loaded the app's module graph first, because `bun test` runs every file in one
     * process and some of that graph decides at module scope whether it has a browser at all. The
     * data is deterministic here; the rendering is checked in a browser.
     */
    const asks = (mine?.requests ?? []) as { ref: string; why: string }[];
    expect(asks.length).toBeGreaterThan(0);
    // Carried verbatim from the template, which is the entire point of the `why` column.
    expect(asks.every((ask) => ask.why.trim().length > 0)).toBe(true);
    expect(asks.some((ask) => ask.ref === "google-drive/search_files")).toBe(
      true,
    );

    const clauses = (mine?.boundaries ?? []) as { expression: string }[];
    expect(clauses.length).toBeGreaterThan(0);
    // Every clause names this Bot first, which is what keeps a broken one from refusing the
    // deployment rather than the coworker. See server/src/templates/boundary.ts.
    expect(
      clauses.every((clause) =>
        clause.expression.startsWith(`bot.id == "${agentId}"`),
      ),
    ).toBe(true);
    expect(
      clauses.some((clause) =>
        clause.expression.includes('intent == "run_command"'),
      ),
    ).toBe(true);
  });
});

/**
 * Everything this file made, taken back on the connection it made it with.
 *
 * The close is last and after the deletes, for the reason the other integration suites record: bun
 * runs every file in one process, and a suite that leaves its pool open eats a connection for the
 * rest of the run, so a later unrelated file dies on a limit rather than on anything it did.
 */
afterAll(async () => {
  if (createdAgents.length > 0) {
    await database.delete(agents).where(inArray(agents.id, createdAgents));
  }
  await database.delete(skills).where(eq(skills.ownerUserId, person.id));
  await database.delete(skills).where(eq(skills.ownerUserId, administrator.id));
  await database
    .delete(users)
    .where(inArray(users.id, [person.id, administrator.id]));
  await database.$client.close();
});
