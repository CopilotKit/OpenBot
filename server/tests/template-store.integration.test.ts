import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { parseBotTemplate } from "../../shared/bot-template";
import { createDatabase } from "../src/db/client";
import {
  agents,
  botTemplates,
  templateBoundaries,
  templateImports,
  users,
} from "../src/db/schema";
import {
  createTemplateStore,
  TemplateNotFoundError,
  TemplateSlugTakenError,
} from "../src/templates/store";

/**
 * The rows a template leaves behind, and the two properties worth asserting about them.
 *
 * The first is that none of them is a permission: a draft is a document, an import is a record of
 * what somebody consented to, and a ledger row is an ask. The second is that a draft belongs to
 * somebody — a person who is not its owner and not an administrator is told it does not exist rather
 * than that it is not theirs, because the alternative turns the drafts route into a way to enumerate
 * what other people are working on.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  { max: 2 },
);

const store = createTemplateStore(database);

const suite = randomUUID().slice(0, 8);
const owner = { id: `user_owner_${suite}`, role: "user" as const };
const stranger = { id: `user_other_${suite}`, role: "user" as const };
const admin = { id: `user_admin_${suite}`, role: "admin" as const };
const bot = `agent_${suite}`;

function yamlFor(slug: string, summary = "Chases overdue invoices.") {
  return `openbot_template: 1

template:
  slug: ${slug}
  version: "1.3"
  author: acme-revops
  summary: ${summary}

bot:
  name: Renewal Desk
  title: Accounts Receivable
  role_description: >-
    Chase overdue invoices. Draft a follow-up for a person to send, and name every
    document you used.
  runtime: managed
  skills: [check-renewal-risk-${suite}]

skills:
  - slug: check-renewal-risk-${suite}
    title: Check renewal risk
    summary: Pull the contract and the recent tickets for one account.
    instructions: >-
      Find the contract and read the renewal date from it. Name each document you used.
    tools:
      - google-drive/search_files

requests:
  connectors:
    - id: google-drive
      why: The invoice ledger export lives in Drive.
      tools:
        - ref: google-drive/search_files
          why: Find the ledger for one customer.
  components:
    - name: showBarChart
      why: Ageing buckets.

boundary:
  shell: never
  files: none
  browser: read_only
  navigate_hosts:
    - billing.acme.example
  mcp: read_only
`;
}

const draftSlug = `renewal-desk-${suite}`;
const template = parseBotTemplate(yamlFor(draftSlug));

beforeAll(async () => {
  await database
    .insert(users)
    .values(
      [owner, stranger, admin].map((actor) => ({
        id: actor.id,
        email: `${actor.id}@openbot.local`,
      })),
    )
    .onConflictDoNothing();
  await database
    .insert(agents)
    .values({ id: bot, name: bot, type: "built_in", configuration: {} })
    .onConflictDoNothing();
});

afterAll(async () => {
  await database
    .delete(templateImports)
    .where(eq(templateImports.agentId, bot));
  await database.delete(agents).where(eq(agents.id, bot));
  await database
    .delete(users)
    .where(inArray(users.id, [owner.id, stranger.id, admin.id]));
});

describe("a template draft", () => {
  test("is created for its author, keeps the Bot it was packed from, and reads back parsed", async () => {
    const draft = await store.createDraft(owner, {
      agentId: bot,
      document: template,
    });

    expect(draft.id.startsWith("tpl_")).toBe(true);
    expect(draft.ownerUserId).toBe(owner.id);
    expect(draft.agentId).toBe(bot);
    expect(draft.slug).toBe(draftSlug);
    // Round-tripped through the format on the way out, so a row nobody can parse is a refusal here
    // rather than a document somebody is asked to consent to.
    expect(draft.document.bot.name).toBe("Renewal Desk");
    expect(draft.document.skills[0]?.tools).toEqual([
      "google-drive/search_files",
    ]);

    await store.deleteDraft(owner, draft.id);
  });

  test("belongs to its author: a stranger is told it does not exist, an administrator sees it", async () => {
    const draft = await store.createDraft(owner, { document: template });

    await expect(store.getDraft(stranger, draft.id)).rejects.toBeInstanceOf(
      TemplateNotFoundError,
    );
    /*
     * The write gate is the read gate. A draft somebody may not see must not be one they can
     * overwrite or delete, and both answer with the same not-found so neither confirms the id.
     */
    await expect(
      store.updateDraft(stranger, draft.id, template),
    ).rejects.toBeInstanceOf(TemplateNotFoundError);
    await expect(store.deleteDraft(stranger, draft.id)).rejects.toBeInstanceOf(
      TemplateNotFoundError,
    );

    expect((await store.getDraft(admin, draft.id)).id).toBe(draft.id);
    expect(
      (await store.listDrafts(owner)).some((entry) => entry.id === draft.id),
    ).toBe(true);
    expect(
      (await store.listDrafts(stranger)).some((entry) => entry.id === draft.id),
    ).toBe(false);

    await store.deleteDraft(admin, draft.id);
  });

  test("is unique per author rather than across the deployment", async () => {
    const mine = await store.createDraft(owner, { document: template });

    // The same person cannot hold two files of one name; the index says so and the store names it.
    await expect(
      store.createDraft(owner, { document: template }),
    ).rejects.toBeInstanceOf(TemplateSlugTakenError);

    /*
     * Somebody else can. A template slug names a file and a draft reaches nobody until it is sent, so
     * two people packing the same Bot must not race each other for a name — unlike `skills.slug`,
     * which is the shared `/` namespace and is deployment-wide first-taker-keeps.
     */
    const theirs = await store.createDraft(stranger, { document: template });
    expect(theirs.slug).toBe(mine.slug);

    await store.deleteDraft(owner, mine.id);
    await store.deleteDraft(stranger, theirs.id);
  });

  test("an edit replaces the document and moves the slug with it", async () => {
    const draft = await store.createDraft(owner, { document: template });
    const renamed = parseBotTemplate(
      yamlFor(`renewal-desk-b-${suite}`, "Now it chases renewals instead."),
    );

    const updated = await store.updateDraft(owner, draft.id, renamed);
    expect(updated.slug).toBe(`renewal-desk-b-${suite}`);
    expect(updated.document.template.summary).toBe(
      "Now it chases renewals instead.",
    );
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
      draft.createdAt.getTime(),
    );

    await store.deleteDraft(owner, draft.id);
    await expect(store.getDraft(owner, draft.id)).rejects.toBeInstanceOf(
      TemplateNotFoundError,
    );
  });

  test("outlives the Bot it was packed from", async () => {
    const spare = `agent_spare_${suite}`;
    await database
      .insert(agents)
      .values({ id: spare, name: spare, type: "built_in", configuration: {} });
    const draft = await store.createDraft(owner, {
      agentId: spare,
      document: template,
    });

    await database.delete(agents).where(eq(agents.id, spare));

    /*
     * `set null` rather than `cascade`. Once the document exists it is an artifact in its own right —
     * the thing that was going to be published, or the thing already sent to somebody — and deleting
     * the coworker it was taken from is not a reason to destroy it.
     */
    const after = await store.getDraft(owner, draft.id);
    expect(after.agentId).toBeNull();

    await store.deleteDraft(owner, draft.id);
  });
});

describe("the provenance of an imported Bot", () => {
  test("records the claim as a claim, and hands back exactly what was consented to", async () => {
    const imported = await store.recordImport({
      agentId: bot,
      digest: "a".repeat(64),
      slug: draftSlug,
      templateVersion: "1.3",
      authorClaim: "acme-revops",
      source: "paste",
      document: template,
      importedBy: "importer@openbot.local",
    });

    expect(imported.agentId).toBe(bot);
    // Named `authorClaim` rather than `author` because nothing verified it and there is nothing it
    // could have been verified against.
    expect(imported.authorClaim).toBe("acme-revops");
    expect(imported.source).toBe("paste");
    expect(imported.sourceRef).toBeNull();
    expect(imported.document.bot.roleDescription).toBe(
      template.bot.roleDescription,
    );

    const read = await store.importForAgent(bot);
    expect(read?.id).toBe(imported.id);
    expect(await store.importForAgent(`agent_absent_${suite}`)).toBeNull();
  });

  test("the ledger holds the ask, and an import never overwrites a decision already made", async () => {
    const imported = await store.importForAgent(bot);
    if (!imported) throw new Error("the provenance row was not written");

    await store.recordRequests([
      {
        importId: imported.id,
        kind: "mcp",
        ref: "google-drive/search_files",
        why: "Find the ledger for one customer.",
        status: "unavailable",
      },
      {
        importId: imported.id,
        kind: "component",
        ref: "showBarChart",
        why: "Ageing buckets.",
        status: "not_in_build",
      },
    ]);

    const ledger = await store.listRequests(imported.id);
    expect(ledger).toHaveLength(2);
    expect(ledger.map((row) => row.status).sort()).toEqual([
      "not_in_build",
      "unavailable",
    ]);
    // Nobody has decided anything yet, and the columns say so rather than defaulting to a person.
    expect(ledger.every((row) => row.decidedBy === null)).toBe(true);

    const decided = await store.decideRequest({
      importId: imported.id,
      kind: "mcp",
      ref: "google-drive/search_files",
      status: "granted",
      decidedBy: "admin@openbot.local",
    });
    expect(decided?.status).toBe("granted");
    expect(decided?.decidedBy).toBe("admin@openbot.local");
    expect(decided?.decidedAt).not.toBeNull();

    /*
     * A retried install must not walk over the administrator's answer. `recordRequests` does nothing
     * on a row that is already there, so the decision survives the same rows being offered again.
     */
    await store.recordRequests([
      {
        importId: imported.id,
        kind: "mcp",
        ref: "google-drive/search_files",
        why: "Find the ledger for one customer.",
        status: "unavailable",
      },
    ]);
    const again = await store.listRequests(imported.id);
    expect(
      again.find((row) => row.ref === "google-drive/search_files")?.status,
    ).toBe("granted");

    expect(
      await store.decideRequest({
        importId: imported.id,
        kind: "mcp",
        ref: "nothing/at-all",
        status: "declined",
        decidedBy: "admin@openbot.local",
      }),
    ).toBeNull();
  });

  test("a boundary is retracted softly, and only once", async () => {
    const imported = await store.importForAgent(bot);
    if (!imported) throw new Error("the provenance row was not written");

    await database.insert(templateBoundaries).values({
      importId: imported.id,
      agentId: bot,
      expression: 'action == "shell"',
      sourceKey: "shell",
    });

    expect(await store.boundariesFor(imported.id)).toHaveLength(1);

    const retired = await store.retractBoundaries(imported.id);
    expect(retired).toHaveLength(1);
    expect(retired[0]?.expression).toBe('action == "shell"');

    /*
     * Soft, so "this Bot was never bounded" and "somebody took this Bot's bound off" are not the same
     * database state — and a second retraction re-stamps nothing, or the date of an act would move to
     * the time somebody asked about it.
     */
    const rows = await store.boundariesFor(imported.id);
    expect(rows[0]?.removedAt).not.toBeNull();
    expect(await store.retractBoundaries(imported.id)).toHaveLength(0);
  });
});

describe("what the store never touches", () => {
  test("a draft is a document and nothing more", async () => {
    const draft = await store.createDraft(owner, { document: template });
    const [row] = await database
      .select()
      .from(botTemplates)
      .where(eq(botTemplates.id, draft.id))
      .limit(1);

    /*
     * The stored value is the parsed document rather than the YAML text, so the digest, the
     * serialiser and the edit path all read one canonical thing. The cost is real and worth stating:
     * an author's own comments do not survive an edit.
     */
    expect(row?.document).toBeDefined();
    expect(JSON.stringify(row?.document)).not.toContain("openbot_template:");

    await store.deleteDraft(owner, draft.id);
  });
});
