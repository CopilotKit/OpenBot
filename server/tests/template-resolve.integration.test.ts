import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  type BotTemplate,
  botTemplateDigest,
  parseBotTemplate,
} from "../../shared/bot-template";
import { createDatabase } from "../src/db/client";
import {
  components,
  mcpServers,
  mcpTools,
  skills,
  skillTools,
  users,
} from "../src/db/schema";
import { resolveBotTemplate, suffixedSlug } from "../src/templates/resolve";

/**
 * The preview, which writes nothing and is the only thing standing between a stranger's file and a
 * person's judgement about it.
 *
 * Two properties are asserted hardest. The first is that `available` is a statement about the
 * DEPLOYMENT and never about the Bot — it says a connector is here, not that anything was granted,
 * and the install path turns it into a ledger row that still says `requested`. The second is that a
 * colliding skill slug is never resolved to an overwrite: `installSkill` upserts on `skills.slug`,
 * so "reuse when identical, else suffix, else skip" is the difference between an import and a way to
 * take somebody's `/` command.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  { max: 2 },
);

const suite = randomUUID().slice(0, 8);
const owner = `user_${suite}`;
const connector = `drive-${suite}`;
const componentName = `showBarChart_${suite}`;
const skillSlug = `check-renewal-${suite}`;
const otherSkill = `already-here-${suite}`;

function yamlFor(options: {
  runtime?: "managed" | "remote";
  skillSlugs?: string[];
  connectorId?: string;
  componentName?: string;
  instructions?: string;
  tools?: string[];
}) {
  const runtime = options.runtime ?? "managed";
  const slugs = options.skillSlugs ?? [skillSlug];
  const tools = options.tools ?? [`${options.connectorId ?? connector}/search`];
  const instructions =
    options.instructions ??
    "Find the contract and read the renewal date from it. Name each document you used.";
  return `openbot_template: 1

template:
  slug: renewal-desk-${suite}
  summary: Chases overdue invoices and drafts the follow-up.

bot:
  name: Renewal Desk
  title: Accounts Receivable
  role_description: >-
    Chase overdue invoices and draft a follow-up for a person to send.
  runtime: ${runtime}
${
  runtime === "remote"
    ? `  remote:
    auth_header: Authorization
    requires_key: true
    example_url: https://renewals.example.com/agui
    sends_conversation_to: renewals.example.com
`
    : ""
}  skills: [${slugs.join(", ")}]

skills:
${slugs
  .map(
    (slug) => `  - slug: ${slug}
    title: Check renewal risk
    summary: Pull the contract and the recent tickets for one account.
    instructions: >-
      ${instructions}
    tools:
${tools.map((ref) => `      - ${ref}`).join("\n")}
`,
  )
  .join("")}
requests:
  connectors:
    - id: ${options.connectorId ?? connector}
      why: The invoice ledger export lives there.
      tools:
        - ref: ${options.connectorId ?? connector}/search
          why: Find the ledger for one customer.
        - ref: ${options.connectorId ?? connector}/never-advertised
          why: Read amounts and due dates.
  components:
    - name: ${options.componentName ?? componentName}
      why: Ageing buckets.

boundary:
  shell: never
  files: none
  browser: read_only
  mcp: read_only
`;
}

async function plan(
  template: BotTemplate,
  options: { managedAgent: boolean } = { managedAgent: true },
) {
  return resolveBotTemplate(database, template, {
    managedAgent: options.managedAgent,
    digest: await botTemplateDigest(template),
  });
}

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@openbot.local` })
    .onConflictDoNothing();
});

afterAll(async () => {
  await database
    .delete(skills)
    .where(
      inArray(skills.slug, [
        skillSlug,
        `${skillSlug}-2`,
        `${skillSlug}-3`,
        otherSkill,
      ]),
    );
  await database.delete(mcpServers).where(eq(mcpServers.id, connector));
  await database.delete(components).where(eq(components.name, componentName));
  await database.delete(users).where(eq(users.id, owner));
});

describe("what a template asks for, against this deployment", () => {
  test("a connector nobody has added is unavailable, and nothing is written to find that out", async () => {
    const template = parseBotTemplate(yamlFor({}));

    const [before] = await database
      .select({ total: sql<number>`count(*)::int` })
      .from(skills);
    const resolved = await plan(template);
    const [after] = await database
      .select({ total: sql<number>`count(*)::int` })
      .from(skills);

    // The preview is a read. A screen a person has not consented to yet must leave no trace of
    // having been shown.
    expect(after?.total).toBe(before?.total);

    expect(resolved.connectors[0]?.verdict).toBe("unavailable");
    expect(
      resolved.connectors[0]?.tools.every(
        (tool) => tool.verdict === "unavailable",
      ),
    ).toBe(true);
    expect(resolved.components[0]?.verdict).toBe("not_in_build");
    // The author's sentence travels with the ask, because it is the only thing on the grant screen
    // that says why.
    expect(resolved.connectors[0]?.why).toBe(
      "The invoice ledger export lives there.",
    );
  });

  test("a server row alone is not enough; the tool row has to be there too", async () => {
    await database.insert(mcpServers).values({
      id: connector,
      title: "A test connector",
      vendor: "Test",
      url: "https://mcp.example.invalid/v1",
    });
    await database
      .insert(mcpTools)
      .values({ serverId: connector, name: "search", description: "Find." });
    await database.insert(components).values({
      name: componentName,
      title: "Bar chart",
      kind: "chart",
      draftDescription: "Draws bars.",
      published: true,
    });

    const resolved = await plan(parseBotTemplate(yamlFor({})));

    expect(resolved.connectors[0]?.verdict).toBe("available");
    /*
     * A connector that is connected but has never been refreshed advertises no tools. Reporting its
     * refs as available would tell the importer a grant is one click away when the grant screen has
     * nothing to list.
     */
    const byRef = new Map(
      resolved.connectors[0]?.tools.map((tool) => [tool.ref, tool.verdict]),
    );
    expect(byRef.get(`${connector}/search`)).toBe("available");
    expect(byRef.get(`${connector}/never-advertised`)).toBe("unavailable");

    expect(resolved.components[0]?.verdict).toBe("available");
    expect(resolved.components[0]?.published).toBe(true);
  });
});

describe("a skill slug this deployment has already given to somebody", () => {
  test("is reused when the skill already here is the same skill", async () => {
    const template = parseBotTemplate(yamlFor({}));
    const shipped = template.skills[0];
    if (!shipped) throw new Error("the fixture defines a skill");

    await database.insert(skills).values({
      id: skillSlug,
      slug: skillSlug,
      ownerUserId: owner,
      title: "Somebody else's title",
      summary: "And somebody else's summary.",
      // Byte-identical instructions and the same declared tools is what "the same skill" means.
      // Title and summary are how a skill is listed, not what it does.
      instructions: shipped.instructions,
      origin: "yours",
      installedBy: `${owner}@openbot.local`,
    });
    await database.insert(skillTools).values(
      shipped.tools.map((ref) => ({
        skillId: skillSlug,
        ref,
        declaredBy: `${owner}@openbot.local`,
      })),
    );

    const resolved = await plan(template);
    const entry = resolved.skills[0];
    expect(entry?.collides).toBe(true);
    expect(entry?.identical).toBe(true);
    expect(entry?.resolution).toBe("reuse");
    expect(entry?.installAs).toBe(skillSlug);
    expect(resolved.slugDecisions[skillSlug]).toBe("reuse");
  });

  test("is suffixed when it is a different skill wearing the same name", async () => {
    const template = parseBotTemplate(
      yamlFor({
        instructions: "Something else entirely, written by somebody.",
      }),
    );

    const resolved = await plan(template);
    const entry = resolved.skills[0];
    expect(entry?.collides).toBe(true);
    expect(entry?.identical).toBe(false);
    expect(entry?.resolution).toBe("suffix");
    expect(entry?.installAs).toBe(`${skillSlug}-2`);

    /*
     * The suffixed slug has to satisfy the FORMAT's rule as well as the database's, and this is the
     * assertion that keeps the copy of the regex in `resolve.ts` honest against the one in
     * `shared/bot-template.ts`: a slug the format would refuse installs cleanly and is then
     * permanently uneditable through every screen in the product.
     */
    const chosen = entry?.installAs;
    if (!chosen) throw new Error("a suffix was expected");
    const round = parseBotTemplate(
      yamlFor({ skillSlugs: [chosen], instructions: "Anything." }),
    );
    expect(round.skills[0]?.slug).toBe(chosen);
  });

  test("walks past a suffix that is also taken", async () => {
    await database.insert(skills).values({
      id: `${skillSlug}-2`,
      slug: `${skillSlug}-2`,
      ownerUserId: owner,
      title: "Also taken",
      summary: "Also taken.",
      instructions: "Also taken.",
      origin: "yours",
      installedBy: `${owner}@openbot.local`,
    });

    const resolved = await plan(
      parseBotTemplate(
        yamlFor({ instructions: "Something else entirely again." }),
      ),
    );
    expect(resolved.skills[0]?.installAs).toBe(`${skillSlug}-3`);
  });

  test("never resolves to an overwrite, whatever it resolves to", async () => {
    const resolved = await plan(
      parseBotTemplate(yamlFor({ instructions: "Different again." })),
    );
    for (const entry of resolved.skills) {
      /*
       * The only way `installAs` may equal a colliding slug is `reuse`, which writes nothing at all.
       * Anything else naming a taken slug would reach `installSkill`'s `onConflictDoUpdate` and take
       * somebody's `/` command with a stranger's instructions.
       */
      if (entry.collides && entry.resolution !== "reuse") {
        expect(entry.installAs).not.toBe(entry.slug);
      }
    }
  });

  test("a name nobody has taken is written as it stands", async () => {
    const fresh = `fresh-${suite}`;
    const resolved = await plan(
      parseBotTemplate(yamlFor({ skillSlugs: [fresh] })),
    );
    expect(resolved.skills[0]?.collides).toBe(false);
    expect(resolved.skills[0]?.installAs).toBe(fresh);
  });
});

describe("a suffix that would not fit", () => {
  test("trims the base rather than producing a slug the product cannot save", () => {
    const long = "a".repeat(40);
    const candidate = suffixedSlug(long, 2);
    expect(candidate).toBe(`${"a".repeat(38)}-2`);
    expect(candidate?.length).toBe(40);
  });

  test("re-cuts a trailing hyphen the trim exposed", () => {
    // `…-` then `-2` would be `…--2`, and a slug ending or doubling a hyphen is refused by the
    // format, installed by the package rule, and then uneditable through the product forever.
    const candidate = suffixedSlug(`${"a".repeat(37)}--`, 2);
    expect(candidate).toBe(`${"a".repeat(37)}-2`);
  });
});

describe("where the coworker runs", () => {
  test("a remote template always asks the importer for the address", async () => {
    const resolved = await plan(
      parseBotTemplate(yamlFor({ runtime: "remote" })),
    );
    expect(resolved.endpoint.required).toBe(true);
    expect(resolved.endpoint.reason).toBe("remote");
    expect(resolved.endpoint.requiresKey).toBe(true);
    // The header NAME is not a secret and travels; the value never does.
    expect(resolved.endpoint.authHeader).toBe("Authorization");
    expect(resolved.endpoint.sendsConversationTo).toBe("renewals.example.com");
  });

  test("a managed template asks too, when this deployment has no Bot in the box", async () => {
    /*
     * The row that is not a nicety. `store.create` throws `ManagedAgentUnavailableError` when there
     * is neither an endpoint nor a managed agent, and the recommended one-container image carries no
     * managed agent — so routing `runtime: managed` straight through `create` would 400 on the
     * default install after a preview that reported nothing to rebind.
     */
    const resolved = await plan(parseBotTemplate(yamlFor({})), {
      managedAgent: false,
    });
    expect(resolved.endpoint.required).toBe(true);
    expect(resolved.endpoint.reason).toBe("no_managed_agent");
  });

  test("and does not, when there is one", async () => {
    const resolved = await plan(parseBotTemplate(yamlFor({})), {
      managedAgent: true,
    });
    expect(resolved.endpoint.required).toBe(false);
    expect(resolved.endpoint.reason).toBeNull();
  });
});
