import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  auditEvents,
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
  TemplateEndpointRefusedError,
  TemplateEndpointRequiredError,
  TemplateSlugDecisionError,
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
/** Somebody the grant screen would let reuse a skill this deployment owns. */
const administrator = {
  id: `admin_${suite}`,
  role: "admin" as const,
  email: `admin-${suite}@openbot.local`,
};
const skillSlug = `check-renewal-${suite}`;
/** A skill this DEPLOYMENT owns: no owner, the shape a tenant package seeds at every boot. */
const deploymentSkill = `ledger-desk-${suite}`;
const managedUrl = new URL("https://managed.example.com/agui");

/** Every Bot this file made, so the teardown can take them and their grants with them. */
const created: string[] = [];

function installer(
  options: {
    managedAgent?: boolean;
    pluginStore?: Pick<PluginStore, "installSkill" | "grant">;
    endpointPolicy?: {
      allowPrivateHosts?: boolean;
      allowedHosts?: ReadonlySet<string>;
    };
  } = {},
) {
  return createTemplateInstaller({
    database,
    templateStore,
    pluginStore: options.pluginStore ?? pluginStore,
    auditStore,
    ...(options.endpointPolicy
      ? { endpointPolicy: options.endpointPolicy }
      : {}),
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
    avatarSeed?: string;
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
${options.avatarSeed ? `  avatar_seed: ${options.avatarSeed}\n` : ""}  role_description: >-
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

/** Two skills in one file, which is how a plan can conflict with itself rather than with here. */
function yamlForPair(first: string, second: string) {
  return `openbot_template: 1

template:
  slug: renewal-pair-${suite}
  summary: Chases overdue invoices and drafts the follow-up.

bot:
  name: Renewal Pair ${suite}
  title: Accounts Receivable
  role_description: >-
    Chase overdue invoices and draft a follow-up for a person to send.
  runtime: managed
  skills: [${first}, ${second}]

skills:
${[first, second]
  .map(
    (slug) => `  - slug: ${slug}
    title: Check renewal risk
    summary: Pull the contract and the recent tickets for one account.
    instructions: >-
      A plan that names one slug twice is the bug this file is about.
    tools:
      - google-drive/search_files
`,
  )
  .join("")}
requests:
  connectors: []
  components: []

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

/** Every skill slug this file can leave behind, whichever branch each test took. */
const touchedSlugs = [
  skillSlug,
  `${skillSlug}-2`,
  `${skillSlug}-3`,
  `other-${suite}`,
  `hand-made-${suite}`,
  `endpoint-${suite}`,
  `avatar-${suite}`,
  `plain-${suite}`,
  `stale-${suite}`,
  `stale-${suite}-2`,
  deploymentSkill,
  `${deploymentSkill}-2`,
  `pair-${suite}`,
  `pair-${suite}-2`,
  `pair-${suite}-2-2`,
  `audit-${suite}`,
];

beforeAll(async () => {
  await database
    .insert(users)
    .values([
      { id: importer.id, email: importer.email },
      { id: administrator.id, email: administrator.email },
    ])
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
  if (created.length > 0) {
    await database.delete(agents).where(inArray(agents.id, created));
  }
  await database.delete(skills).where(inArray(skills.slug, touchedSlugs));
  await database
    .delete(users)
    .where(inArray(users.id, [importer.id, administrator.id]));

  await database.$client.close();
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

describe("a skill this deployment owns, and a template shipping a copy of it", () => {
  /*
   * The text of every skill a tenant package seeds is on the Skills page, so producing a
   * byte-identical copy is something anybody signed in can do. `reuse` then looked like the obvious
   * resolution and wrote a `plugin_grants` row pairing the importer's Bot to the DEPLOYMENT's skill
   * — a write `POST /api/plugins/grants` refuses that same person outright, under a `granted_by` of
   * `template:<digest>` rather than a person's name. The instructions were the ones they consented
   * to that day; the point is the day after, when an administrator edits that row.
   */
  beforeAll(async () => {
    await database.insert(skills).values({
      id: deploymentSkill,
      slug: deploymentSkill,
      // Null is the whole fixture: this skill belongs to the deployment and nobody else.
      ownerUserId: null,
      title: "The deployment's own",
      summary: "Seeded at boot by the tenant package.",
      instructions: "Find the contract and read the renewal date from it.",
      origin: "catalogue",
      installedBy: "package",
    });
    await database.insert(skillTools).values({
      skillId: deploymentSkill,
      ref: "google-drive/search_files",
      declaredBy: "package",
    });
  });

  test("gives a non-admin their own copy rather than a pairing nobody decided", async () => {
    const template = parseBotTemplate(yamlFor({ skillSlug: deploymentSkill }));
    const [before] = await database
      .select()
      .from(skills)
      .where(eq(skills.slug, deploymentSkill))
      .limit(1);

    const result = await installer().installBotTemplate({
      template,
      digest: await digested(template),
      actor: importer,
      source: "paste",
      slugDecisions: {},
    });
    created.push(result.agentId);

    expect(result.skillsReused).toHaveLength(0);
    expect(result.skillsSuffixed).toEqual([`${deploymentSkill}-2`]);

    // The Bot is paired to the copy, and nothing on this deployment's own row moved.
    const held = await grantsFor(result.agentId);
    expect(held).toHaveLength(1);
    expect(held[0]?.ref).toBe(`${deploymentSkill}-2`);
    expect(
      await database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.ref, deploymentSkill)),
    ).toHaveLength(0);

    const [after] = await database
      .select()
      .from(skills)
      .where(eq(skills.slug, deploymentSkill))
      .limit(1);
    expect(after?.ownerUserId).toBeNull();
    expect(after?.instructions).toBe(before?.instructions);
    expect(after?.updatedAt).toEqual(before?.updatedAt);

    const [copy] = await database
      .select()
      .from(skills)
      .where(eq(skills.slug, `${deploymentSkill}-2`))
      .limit(1);
    // Word for word what the consent screen showed, and theirs.
    expect(copy?.ownerUserId).toBe(importer.id);
    expect(copy?.instructions).toBe(before?.instructions);
  });

  test("lets an administrator, who could grant it by hand, reuse it", async () => {
    const template = parseBotTemplate(yamlFor({ skillSlug: deploymentSkill }));
    const result = await installer().installBotTemplate({
      template,
      digest: await digested(template),
      actor: administrator,
      source: "paste",
      slugDecisions: {},
    });
    created.push(result.agentId);

    expect(result.skillsReused).toEqual([deploymentSkill]);
    expect(result.skillsSuffixed).toHaveLength(0);
    expect((await grantsFor(result.agentId))[0]?.ref).toBe(deploymentSkill);
  });
});

describe("a reuse decision that no longer describes the deployment", () => {
  test("is refused rather than pairing the Bot to somebody else's text", async () => {
    /*
     * The preview said `identical: true`, so `reuse` was offered and preselected; somebody then
     * edited that skill, and the client posts the decision it is still holding. Pairing the Bot
     * anyway gives an imported coworker instructions nobody consented to — the person read text A
     * and the Bot would run on text B, with `skillsReused` reporting success.
     */
    await database.insert(skills).values({
      id: `stale-${suite}`,
      slug: `stale-${suite}`,
      ownerUserId: importer.id,
      title: "Edited since the preview",
      summary: "Somebody rewrote this between the screen and the click.",
      instructions: "Something a person rewrote after the preview was drawn.",
      origin: "yours",
      installedBy: importer.email,
    });

    const template = parseBotTemplate(yamlFor({ skillSlug: `stale-${suite}` }));
    const before = await database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, `Renewal Desk ${suite}`));

    await expect(
      installer().installBotTemplate({
        template,
        digest: await digested(template),
        actor: importer,
        source: "paste",
        slugDecisions: { [`stale-${suite}`]: "reuse" },
      }),
    ).rejects.toBeInstanceOf(TemplateSlugDecisionError);

    // Nothing at all: not the Bot, not a suffixed copy, not a grant.
    const after = await database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, `Renewal Desk ${suite}`));
    expect(after).toHaveLength(before.length);
    expect(
      await database
        .select()
        .from(skills)
        .where(eq(skills.slug, `stale-${suite}-2`)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(pluginGrants)
        .where(eq(pluginGrants.ref, `stale-${suite}`)),
    ).toHaveLength(0);
  });
});

describe("two skills in one file that plan into the same name", () => {
  test("each lands under the name the plan gave it", async () => {
    /*
     * The deployment holds `pair-<suite>`; the file ships `pair-<suite>` and `pair-<suite>-2`. The
     * first suffixes onto the second's own name, and a plan that reads only the `skills` table
     * hands both of them `pair-<suite>-2`. Install then walked the second to a name that had
     * appeared on no screen the importer read.
     */
    await database.insert(skills).values({
      id: `pair-${suite}`,
      slug: `pair-${suite}`,
      ownerUserId: importer.id,
      title: "Already here",
      summary: "Already here.",
      instructions: "Already here, and not what the file ships.",
      origin: "yours",
      installedBy: importer.email,
    });

    const template = parseBotTemplate(
      yamlForPair(`pair-${suite}`, `pair-${suite}-2`),
    );
    const result = await installer().installBotTemplate({
      template,
      digest: await digested(template),
      actor: importer,
      source: "paste",
      slugDecisions: {},
    });
    created.push(result.agentId);

    const planned = result.plan.skills.map((entry) => entry.installAs);
    expect(planned).toEqual([`pair-${suite}-2`, `pair-${suite}-2-2`]);
    expect(result.skillsSuffixed).toEqual([
      `pair-${suite}-2`,
      `pair-${suite}-2-2`,
    ]);
    // What the plan said and what the deployment got are the same two names.
    const written = await database
      .select({ slug: skills.slug })
      .from(skills)
      .where(inArray(skills.slug, [`pair-${suite}-2`, `pair-${suite}-2-2`]));
    expect(written).toHaveLength(2);
    const refs = (await grantsFor(result.agentId)).map((row) => row.ref).sort();
    expect(refs).toEqual([`pair-${suite}-2`, `pair-${suite}-2-2`]);
  });
});

describe("an address this deployment will not dial", () => {
  /*
   * THE CHECK THAT KEEPS THE ADDRESS OUT OF THE DATABASE. `POST /api/templates/install` forwards
   * what it was given, so `installBotTemplate` is the whole of the registration-time control on
   * this path — `createAgentFetch` re-checks the stored address before every dial, so a regression
   * here is not immediately an SSRF, but it does mean `http://169.254.169.254/` gets written down
   * as a coworker's endpoint and everything downstream treats a stored agent as trustworthy.
   * Nothing exercised this at all: dropping the call, passing `allowPrivateHosts: true`, or
   * drifting off `config.agentEndpointAllowedHosts` were all invisible to the suite.
   */
  const cold = () => installer({ managedAgent: false });

  async function botCount() {
    const rows = await database
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.name, `Renewal Desk ${suite}`));
    return rows.length;
  }

  test("refuses the metadata address, and writes nothing", async () => {
    const template = parseBotTemplate(
      yamlFor({ skillSlug: `endpoint-${suite}` }),
    );
    const before = await botCount();

    await expect(
      cold().installBotTemplate({
        template,
        digest: await digested(template),
        actor: importer,
        source: "paste",
        endpoint: "http://169.254.169.254/agui",
        slugDecisions: {},
      }),
    ).rejects.toBeInstanceOf(TemplateEndpointRefusedError);

    expect(await botCount()).toBe(before);
    expect(
      await database
        .select()
        .from(skills)
        .where(eq(skills.slug, `endpoint-${suite}`)),
    ).toHaveLength(0);
  });

  test("refuses a private address this deployment has not named", async () => {
    const template = parseBotTemplate(
      yamlFor({ skillSlug: `endpoint-${suite}` }),
    );
    const before = await botCount();

    await expect(
      cold().installBotTemplate({
        template,
        digest: await digested(template),
        actor: importer,
        source: "paste",
        endpoint: "http://10.0.0.7:8080/agui",
        slugDecisions: {},
      }),
    ).rejects.toBeInstanceOf(TemplateEndpointRefusedError);
    expect(await botCount()).toBe(before);
  });

  test("takes the same address once the deployment names it", async () => {
    /*
     * A company's own agent legitimately lives at an internal address, and the policy this module
     * is handed is the one that says so. Naming it host by host is a different act from dropping
     * the floor for the whole network.
     */
    const template = parseBotTemplate(
      yamlFor({ skillSlug: `endpoint-${suite}` }),
    );
    const result = await installer({
      managedAgent: false,
      endpointPolicy: { allowedHosts: new Set(["10.0.0.7:8080"]) },
    }).installBotTemplate({
      template,
      digest: await digested(template),
      actor: importer,
      source: "paste",
      endpoint: "http://10.0.0.7:8080/agui",
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
    ).toBe("http://10.0.0.7:8080/agui");
    // The host, never the path, is what the ledger row says.
    expect(result.ledger.find((row) => row.kind === "endpoint")?.ref).toBe(
      "10.0.0.7:8080",
    );
  });
});

describe("the face on the consent screen", () => {
  test("is the face the imported Bot arrives with", async () => {
    /*
     * The screen draws the avatar from `bot.avatar_seed`, and `create` hardcodes the seed to the
     * agent id — so a person read one face, pressed the one button, and got a different one, with
     * no route anywhere that could repair it afterwards.
     */
    const template = parseBotTemplate(
      yamlFor({ skillSlug: `avatar-${suite}`, avatarSeed: "renewal-desk" }),
    );
    const result = await installer().installBotTemplate({
      template,
      digest: await digested(template),
      actor: importer,
      source: "paste",
      slugDecisions: {},
    });
    created.push(result.agentId);

    const [profile] = await database
      .select({ avatarSeed: agentProfiles.avatarSeed })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, result.agentId))
      .limit(1);
    expect(profile?.avatarSeed).toBe("renewal-desk");
  });

  test("is the Bot's own id when the file carries no seed", async () => {
    // `POST /api/agents` is untouched by the above: a Bot nobody gave a seed still gets its id.
    const template = parseBotTemplate(yamlFor({ skillSlug: `plain-${suite}` }));
    const result = await installer().installBotTemplate({
      template,
      digest: await digested(template),
      actor: importer,
      source: "paste",
      slugDecisions: {},
    });
    created.push(result.agentId);

    const [profile] = await database
      .select({ avatarSeed: agentProfiles.avatarSeed })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, result.agentId))
      .limit(1);
    expect(profile?.avatarSeed).toBe(result.agentId);
  });
});

describe("the trail an import leaves", () => {
  test("carries the slugs and the counts, and never a stranger's prose", async () => {
    /*
     * `redactAuditPayload` is a key-NAME filter and would pass a field called `roleDescription` or
     * `instructions` through verbatim, so the rule is kept at the call site — which is exactly the
     * kind of rule that decays without a test. The export side has had this assertion since it
     * shipped; the import side is the one carrying text a stranger wrote.
     */
    const template = parseBotTemplate(yamlFor({ skillSlug: `audit-${suite}` }));
    const result = await installer().installBotTemplate({
      template,
      digest: await digested(template),
      actor: importer,
      source: "paste",
      slugDecisions: {},
    });
    created.push(result.agentId);

    const rows = await database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, result.agentId));
    const imported = rows.find((row) => row.eventType === "template.imported");
    const asks = rows.filter(
      (row) => row.eventType === "template.capability_requested",
    );
    expect(imported).toBeDefined();
    expect(asks.length).toBeGreaterThan(0);

    // Not vacuous: the things that DO travel are here.
    const payload = imported?.payload as Record<string, unknown>;
    expect(payload.authorClaim).toBe("acme-revops");
    expect(payload.digest).toBe(result.imported.digest);
    expect(payload.skillsCreated).toEqual([`audit-${suite}`]);

    const prose = [
      // The role description, the skill's instructions, and every author's `why`.
      "Chase overdue invoices",
      "Find the contract and read the renewal date",
      "The invoice ledger export lives in Drive.",
      "Find the ledger for one customer.",
      "Ageing buckets.",
    ];
    for (const row of [imported, ...asks]) {
      const serialised = JSON.stringify(row?.payload);
      for (const sentence of prose) {
        expect(serialised).not.toContain(sentence);
      }
    }
  });
});

describe("the import path and MCP grants", () => {
  test("contains no code that writes one, conditional or otherwise", async () => {
    /*
     * A grep rather than a paragraph, and rather than only the behavioural tests either side of it.
     * Behaviour covers the fixtures somebody thought of; it cannot catch a future conditional path
     * behind a config flag or for a connector shape no fixture uses. `store.grant` performs no
     * existence check and `listServers` computes `withdrawn` only for servers that exist, so such a
     * row would be invisible on every screen and would go live the day somebody added that
     * connector, with nobody deciding.
     *
     * Scoped to the import path. `templates/routes.ts` grants `mcp` on purpose, after an
     * administrator has decided on a screen that already refuses, and forbidding that would forbid
     * the thing the feature is for.
     */
    for (const path of [
      "src/templates/install.ts",
      "src/templates/resolve.ts",
      "src/templates/store.ts",
    ]) {
      const source = await readFile(
        new URL(`../${path}`, import.meta.url),
        "utf8",
      );
      expect(source).not.toMatch(/grant\(\s*["'`]mcp["'`]/);
      // And no way around the store either: the import path writes `plugin_grants` through
      // `pluginStore.grant` or not at all. `install.ts` deletes from that table when it retracts,
      // which is why only the insert is named.
      expect(source).not.toMatch(/\.insert\(\s*pluginGrants/);
    }

    // And the one grant an import does make is the Bot-to-skill pairing, by name.
    const install = await readFile(
      new URL("../src/templates/install.ts", import.meta.url),
      "utf8",
    );
    const calls = [
      ...install.matchAll(/pluginStore\.grant\(\s*["'`](\w+)["'`]/g),
    ];
    expect(calls.map((match) => match[1])).toEqual(["skill"]);
  });
});
