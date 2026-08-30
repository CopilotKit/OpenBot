import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  type BotTemplate,
  botTemplateDigest,
  parseBotTemplate,
  templateGrantMark,
} from "../../shared/bot-template";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  pluginGrants,
  skills,
  skillTools,
  templateImports,
  users,
} from "../src/db/schema";
import { createPluginStore, type PluginStore } from "../src/plugins/store";
import {
  createTemplateInstaller,
  TemplateDigestMovedError,
  TemplateEndpointRequiredError,
} from "../src/templates/install";
import { createTemplateStore } from "../src/templates/store";

/**
 * An import as one act, and the four things it must never do.
 *
 * It must never write an MCP grant — `store.grant` performs no existence check and `listServers`
 * computes `withdrawn` only for servers that exist, so an optimistic grant for an absent connector
 * is invisible on every screen and goes live the day an administrator adds that connector, with
 * nobody deciding. It must never overwrite a skill somebody else wrote, because `installSkill`
 * upserts on `skills.slug`. It must never leave half of itself behind when a later step fails. And a
 * retraction must never take back a grant an administrator made by hand.
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

const suite = randomUUID().slice(0, 8);
const importer = {
  id: `user_${suite}`,
  role: "user" as const,
  email: `importer-${suite}@openbot.local`,
};
const skillSlug = `check-renewal-${suite}`;
const managedUrl = new URL("https://managed.example.com/agui");

/** Every Bot this file made, so the teardown can take them and their grants with them. */
const created: string[] = [];

function installer(
  options: {
    managedAgent?: boolean;
    pluginStore?: Pick<PluginStore, "installSkill" | "grant">;
  } = {},
) {
  return createTemplateInstaller({
    database,
    templateStore,
    pluginStore: options.pluginStore ?? pluginStore,
    auditStore,
    ...(options.managedAgent === false
      ? {}
      : { managedAgentAgUiUrl: managedUrl }),
  });
}

function yamlFor(
  options: {
    runtime?: "managed" | "remote";
    skillSlug?: string;
    instructions?: string;
  } = {},
) {
  const runtime = options.runtime ?? "managed";
  const slug = options.skillSlug ?? skillSlug;
  return `openbot_template: 1

template:
  slug: renewal-desk-${suite}
  version: "1.3"
  author: acme-revops
  summary: Chases overdue invoices and drafts the follow-up.

bot:
  name: Renewal Desk ${suite}
  title: Accounts Receivable
  role_description: >-
    Chase overdue invoices. Draft a follow-up for a person to send, and name every
    document you used.
  runtime: ${runtime}
${
  runtime === "remote"
    ? `  remote:
    auth_header: Authorization
    requires_key: false
    sends_conversation_to: renewals.example.com
`
    : ""
}  skills: [${slug}]

skills:
  - slug: ${slug}
    title: Check renewal risk
    summary: Pull the contract and the recent tickets for one account.
    instructions: >-
      ${options.instructions ?? "Find the contract and read the renewal date from it."}
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
  mcp: read_only
`;
}

async function digested(template: BotTemplate) {
  return botTemplateDigest(template);
}

async function grantsFor(agentId: string) {
  return database
    .select()
    .from(pluginGrants)
    .where(eq(pluginGrants.agentId, agentId));
}

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: importer.id, email: importer.email })
    .onConflictDoNothing();
});

afterAll(async () => {
  if (created.length > 0) {
    await database.delete(agents).where(inArray(agents.id, created));
  }
  await database
    .delete(skills)
    .where(
      inArray(skills.slug, [
        skillSlug,
        `${skillSlug}-2`,
        `${skillSlug}-3`,
        `other-${suite}`,
        `hand-made-${suite}`,
      ]),
    );
  await database.delete(users).where(eq(users.id, importer.id));
});

describe("an import on a deployment that has connected nothing", () => {
  test("creates the Bot cold, records the ask, and grants no MCP anything", async () => {
    const template = parseBotTemplate(yamlFor());
    const digest = await digested(template);

    const result = await installer().installBotTemplate({
      template,
      digest,
      actor: importer,
      source: "paste",
      slugDecisions: {},
    });
    created.push(result.agentId);

    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, result.agentId))
      .limit(1);
    // Forced, both of them. A template has no field that could carry an owner or a visibility, and
    // making it public is an ordinary later PATCH the owner makes on a Bot they can already see.
    expect(profile?.ownerUserId).toBe(importer.id);
    expect(profile?.visibility).toBe("private");
    expect(profile?.roleDescription).toBe(template.bot.roleDescription);

    const [skill] = await database
      .select()
      .from(skills)
      .where(eq(skills.slug, skillSlug))
      .limit(1);
    // The importer's own, and marked as having come from a template rather than from the catalogue
    // or from somebody typing it here.
    expect(skill?.ownerUserId).toBe(importer.id);
    expect(skill?.origin).toBe("template");
    expect(skill?.installedBy).toBe(importer.email);

    /*
     * The declaration survives even though this deployment has never connected Drive. A declared ref
     * grants nothing — the run-time offer is granted ∩ declared — so an unknown one is inert, and
     * refusing it would mean a template could only ship skills for connectors it could guarantee,
     * which is none of them.
     */
    const declared = await database
      .select()
      .from(skillTools)
      .where(eq(skillTools.skillId, skillSlug));
    expect(declared.map((row) => row.ref)).toEqual([
      "google-drive/search_files",
    ]);

    const held = await grantsFor(result.agentId);
    expect(held).toHaveLength(1);
    expect(held[0]?.kind).toBe("skill");
    expect(held[0]?.ref).toBe(skillSlug);
    // The mark, so a retraction takes back exactly what this import gave.
    expect(held[0]?.grantedBy).toBe(templateGrantMark(digest));

    /*
     * THE PROPERTY THIS WHOLE FEATURE RESTS ON. Not "no mcp grant on this Bot" — no mcp grant
     * anywhere naming what the template asked for, because such a row would be invisible on every
     * screen and would go live the day somebody connected Drive.
     */
    const optimistic = await database
      .select()
      .from(pluginGrants)
      .where(
        and(
          eq(pluginGrants.kind, "mcp"),
          eq(pluginGrants.ref, "google-drive/search_files"),
        ),
      );
    expect(optimistic).toHaveLength(0);

    const ledger = result.ledger;
    expect(
      ledger.find((row) => row.ref === "google-drive/search_files")?.status,
    ).toBe("unavailable");
    expect(ledger.find((row) => row.ref === "showBarChart")?.status).toBe(
      "not_in_build",
    );
    // The author's sentence is carried into the ledger, because it is the only thing on the grant
    // screen that says why.
    expect(
      ledger.find((row) => row.ref === "google-drive/search_files")?.why,
    ).toBe("Find the ledger for one customer.");
    expect(ledger.every((row) => row.decidedBy === null)).toBe(true);

    expect(result.imported.authorClaim).toBe("acme-revops");
    expect(result.imported.templateVersion).toBe("1.3");
    expect(result.skillsCreated).toEqual([skillSlug]);
  });
});

describe("the window between the consent screen and the click", () => {
  test("a digest that moved is refused, and nothing is written", async () => {
    const template = parseBotTemplate(yamlFor({ skillSlug: `other-${suite}` }));

    const before = await database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, `Renewal Desk ${suite}`));

    await expect(
      installer().installBotTemplate({
        template,
        digest: "b".repeat(64),
        actor: importer,
        source: "paste",
        slugDecisions: {},
      }),
    ).rejects.toBeInstanceOf(TemplateDigestMovedError);

    const after = await database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, `Renewal Desk ${suite}`));
    expect(after).toHaveLength(before.length);
    expect(
      await database
        .select()
        .from(skills)
        .where(eq(skills.slug, `other-${suite}`)),
    ).toHaveLength(0);
  });
});

describe("a step that fails after the skills are in", () => {
  test("takes the Bot, the skills and the grants back with it", async () => {
    const template = parseBotTemplate(yamlFor({ skillSlug: `other-${suite}` }));
    const digest = await digested(template);

    const before = await database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, `Renewal Desk ${suite}`));

    /*
     * Whatever fails after the skills are in: a ledger row, a boundary that will not compile, a
     * network blip on the vault. Without one transaction this leaves an orphan Bot holding half a
     * skill set, the person presses import again, and the deployment now has two.
     */
    const failing = {
      installSkill: pluginStore.installSkill,
      grant: async () => {
        throw new Error("the step after the skills failed");
      },
    };

    await expect(
      installer({ pluginStore: failing }).installBotTemplate({
        template,
        digest,
        actor: importer,
        source: "paste",
        slugDecisions: {},
      }),
    ).rejects.toThrow("the step after the skills failed");

    const after = await database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, `Renewal Desk ${suite}`));
    expect(after).toHaveLength(before.length);
    expect(
      await database
        .select()
        .from(skills)
        .where(eq(skills.slug, `other-${suite}`)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(templateImports)
        .where(eq(templateImports.digest, digest)),
    ).toHaveLength(0);
  });
});

describe("a skill slug this deployment has already given to somebody", () => {
  test("is reused when identical, suffixed when not, and never overwritten", async () => {
    /*
     * The first import took `check-renewal-<suite>` and wrote the template's own instructions there.
     * A second import of a template shipping DIFFERENT instructions under the same slug must not
     * touch it: `installSkill`'s `onConflictDoUpdate` on `skills.slug` would silently replace
     * somebody's `/` command with a stranger's text.
     */
    const [original] = await database
      .select()
      .from(skills)
      .where(eq(skills.slug, skillSlug))
      .limit(1);

    const different = parseBotTemplate(
      yamlFor({
        instructions: "Something else entirely, written by somebody.",
      }),
    );
    const suffixed = await installer().installBotTemplate({
      template: different,
      digest: await digested(different),
      actor: importer,
      source: "paste",
      slugDecisions: {},
    });
    created.push(suffixed.agentId);

    expect(suffixed.skillsSuffixed).toEqual([`${skillSlug}-2`]);
    expect(suffixed.skillsCreated).toHaveLength(0);
    const [untouched] = await database
      .select()
      .from(skills)
      .where(eq(skills.slug, skillSlug))
      .limit(1);
    expect(untouched?.instructions).toBe(original?.instructions);
    expect(untouched?.updatedAt).toEqual(original?.updatedAt);
    // The Bot is paired to the copy it was given, never to the one that was already here.
    expect((await grantsFor(suffixed.agentId))[0]?.ref).toBe(`${skillSlug}-2`);

    // The same file again: byte-identical instructions and the same declarations, so the skill
    // already here IS this skill and nothing is written.
    const identical = parseBotTemplate(yamlFor());
    const reused = await installer().installBotTemplate({
      template: identical,
      digest: await digested(identical),
      actor: importer,
      source: "paste",
      slugDecisions: {},
    });
    created.push(reused.agentId);
    expect(reused.skillsReused).toEqual([skillSlug]);
    expect(reused.skillsCreated).toHaveLength(0);
    expect((await grantsFor(reused.agentId))[0]?.ref).toBe(skillSlug);
  });

  test("is skipped when the importer says so, and the Bot arrives without it", async () => {
    const different = parseBotTemplate(
      yamlFor({ instructions: "A third set of instructions again." }),
    );
    const skipped = await installer().installBotTemplate({
      template: different,
      digest: await digested(different),
      actor: importer,
      source: "paste",
      slugDecisions: { [skillSlug]: "skip" },
    });
    created.push(skipped.agentId);

    expect(skipped.skillsSkipped).toEqual([skillSlug]);
    // Degrade, never block. An unmet ask does not stop the install; the Bot simply arrives colder.
    expect(await grantsFor(skipped.agentId)).toHaveLength(0);
    expect(
      await database
        .select()
        .from(skills)
        .where(eq(skills.slug, `${skillSlug}-3`)),
    ).toHaveLength(0);
  });
});

describe("a managed template on a deployment with no Bot in the box", () => {
  test("refuses without an address, and installs with the one the importer typed", async () => {
    const template = parseBotTemplate(
      yamlFor({ skillSlug: `hand-made-${suite}` }),
    );
    const digest = await digested(template);
    const cold = installer({ managedAgent: false });

    /*
     * `store.create` throws `ManagedAgentUnavailableError` when there is neither an endpoint nor a
     * managed agent, and the recommended one-container image carries no managed agent. Said here as
     * a slot the importer fills rather than as a 400 after a preview that reported nothing to
     * rebind.
     */
    await expect(
      cold.installBotTemplate({
        template,
        digest,
        actor: importer,
        source: "paste",
        slugDecisions: {},
      }),
    ).rejects.toBeInstanceOf(TemplateEndpointRequiredError);

    const result = await cold.installBotTemplate({
      template,
      digest,
      actor: importer,
      source: "paste",
      endpoint: "https://renewals.example.com/agui",
      slugDecisions: {},
    });
    created.push(result.agentId);

    const [agent] = await database
      .select({ configuration: agents.configuration })
      .from(agents)
      .where(eq(agents.id, result.agentId))
      .limit(1);
    expect(
      (agent?.configuration as { endpoint?: string } | null)?.endpoint,
    ).toBe("https://renewals.example.com/agui");

    /*
     * The one ask an import answers on the spot, because the importer answered it. The ref is the
     * host rather than the whole address: a ledger row is read back by people, and the path of an
     * AG-UI endpoint is neither interesting nor always free of something somebody put there.
     */
    const slot = result.ledger.find((row) => row.kind === "endpoint");
    expect(slot?.ref).toBe("renewals.example.com");
    expect(slot?.status).toBe("granted");
    expect(slot?.decidedBy).toBe(importer.email);
  });
});

describe("retracting an import", () => {
  test("takes back what it gave and leaves an administrator's own grant alone", async () => {
    const template = parseBotTemplate(yamlFor());
    const digest = await digested(template);
    const result = await installer().installBotTemplate({
      template,
      digest,
      actor: importer,
      source: "gallery",
      sourceRef: "renewal-desk.openbot.yaml",
      slugDecisions: {},
    });
    created.push(result.agentId);

    // A grant somebody made by hand on the same Bot, afterwards, through the screen that already
    // refuses. Its `granted_by` is a person, which is why the mark cannot collide with it.
    await pluginStore.grant(
      "skill",
      `${skillSlug}-2`,
      result.agentId,
      "admin@openbot.local",
    );
    expect(await grantsFor(result.agentId)).toHaveLength(2);

    const retracted = await installer().retractTemplateImport({
      actor: importer,
      agentId: result.agentId,
    });

    expect(retracted.revoked).toEqual([{ kind: "skill", ref: skillSlug }]);
    const left = await grantsFor(result.agentId);
    expect(left).toHaveLength(1);
    expect(left[0]?.ref).toBe(`${skillSlug}-2`);
    expect(left[0]?.grantedBy).toBe("admin@openbot.local");

    /*
     * The Bot stays, the skill stays, and so does the provenance. Retracting an import takes back
     * what the import GAVE; it does not delete a coworker somebody has been using, a skill that is
     * now in somebody's `/` menu, or the record of what was consented to.
     */
    expect(
      await database
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, result.agentId)),
    ).toHaveLength(1);
    expect(
      await database.select().from(skills).where(eq(skills.slug, skillSlug)),
    ).toHaveLength(1);
    expect(await templateStore.importForAgent(result.agentId)).not.toBeNull();
  });
});
