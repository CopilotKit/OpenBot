/**
 * The plan a person consents to, worked out against this deployment and WRITING NOTHING.
 *
 * Parsing answers what a template says. Resolving answers what would happen if it were installed
 * here, which is a different question and the only one worth putting on a consent screen: the same
 * file lands as a working coworker on a deployment that has Drive connected and as a cold one on a
 * deployment that does not, and the person clicking the button is entitled to know which they are
 * about to get.
 *
 * NOTHING HERE IS A GRANT AND NOTHING HERE IS A WRITE. `available` means an `mcp_servers` row and an
 * `mcp_tools` row both exist, which is a statement about the deployment and not about this Bot — it
 * is still rendered as a request, there is still no checkbox, and satisfying it is still a separate
 * act on a screen that already refuses. The verdict exists so the screen can say "Drive is connected
 * here, an administrator can grant this in one click" rather than making the importer discover that
 * for themselves.
 *
 * The install path re-runs this on its own transaction rather than trusting the plan it was handed.
 * A preview is a screen a person read; it is not evidence about the database a second later.
 */
import { inArray } from "drizzle-orm";
import type { BotTemplate } from "../../../shared/bot-template";
import {
  components,
  mcpServers,
  mcpTools,
  skills,
  skillTools,
} from "../db/schema";
import type { TemplateReadExecutor } from "./store";

/**
 * The Skills API's slug rule, restated.
 *
 * `shared/bot-template.ts` does not export its regex, so this is a second copy of a rule and
 * therefore a place two things can drift. It is here rather than imported because a suffixed slug
 * has to satisfy the format as well as the database — a suffix that produced `renewal-desk-` would
 * install cleanly and then be permanently uneditable through the product, which is the exact bug the
 * format's stricter rule exists to prevent. The integration test for suffixing puts the slug it
 * chose back through `parseBotTemplate`, so the two copies cannot silently disagree.
 */
const TEMPLATE_SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** The format's own ceiling on a slug. Restated for the same reason and pinned by the same test. */
const SLUG_LIMIT = 40;

/**
 * How far a suffix search goes before it gives up and says skip.
 *
 * Twenty, which is far past any real deployment and short enough that a pathological template cannot
 * turn one install into a hundred index probes per skill. Running out is not an error: it lands on
 * `skip`, which is a resolution the screen can already render and the importer can already see.
 */
export const MAX_SUFFIX = 20;

/** What happens to a skill slug this deployment has already given to somebody. */
export type SlugResolution = "reuse" | "suffix" | "skip";

export type ConnectorToolVerdict = "available" | "unavailable";

export type ResolvedTool = {
  ref: string;
  /** The author's sentence. A stranger's prose, rendered as such. */
  why: string;
  verdict: ConnectorToolVerdict;
};

export type ResolvedConnector = {
  id: string;
  why: string;
  /** `available` only when this deployment has an `mcp_servers` row for it. */
  verdict: ConnectorToolVerdict;
  tools: ResolvedTool[];
};

export type ResolvedComponent = {
  name: string;
  why: string;
  /** `not_in_build` when this build ships no component by that name. No row is created either way. */
  verdict: "available" | "not_in_build";
  /**
   * Whether the component is published, when it exists at all.
   *
   * Reported rather than folded into the verdict. An unpublished component is never offered to a
   * model, so a template asking for one is asking for something inert today — but it is in the
   * build, and telling the importer "this build has no such component" would be false.
   */
  published: boolean;
};

export type ResolvedSkill = {
  /** The slug the template names. */
  slug: string;
  title: string;
  /** Whether this deployment already has a skill by that slug. */
  collides: boolean;
  /**
   * Whether the skill already here is byte-identical: the same instructions AND the same declared
   * tools. Title and summary are deliberately not compared — they are how a skill is listed, not
   * what it does, and a difference in either is not a reason to fork somebody's `/` command.
   */
  identical: boolean;
  /** What will happen unless the importer says otherwise. */
  resolution: SlugResolution;
  /**
   * The slug that would actually be written, or null when nothing will be.
   *
   * For `reuse` this is the colliding slug and no skill is written at all — the existing one is
   * paired to the Bot. For `suffix` it is the first free `slug-2`, `slug-3`, … that still satisfies
   * the format's rule. For `skip` it is null and the Bot arrives without that skill.
   */
  installAs: string | null;
  /** Free suffixes this deployment has, in order, so the screen can offer the radio a real value. */
  suffixCandidate: string | null;
  /** Whether the template's own Bot is paired to this skill, or it is merely defined in the file. */
  paired: boolean;
};

export type ResolvedEndpoint = {
  /** Whether the importer has to type an address for this coworker to exist at all. */
  required: boolean;
  /**
   * Why a slot is being shown.
   *
   * `remote` is the ordinary case. `no_managed_agent` is the one that matters: `store.create` throws
   * `ManagedAgentUnavailableError` when there is neither an endpoint nor a managed agent, and the
   * recommended one-container image carries no managed agent, so routing `runtime: managed` straight
   * through `create` would 400 on the default install after a preview that reported nothing to
   * rebind. That is the same coupling that makes `duplicate` unusable on that image today, and the
   * import path must not inherit it.
   */
  reason: "remote" | "no_managed_agent" | null;
  /** The author says the importer will be asked for a key. A claim, not a capability. */
  requiresKey: boolean;
  /** The header NAME the author uses, if any. A header name is not a secret. */
  authHeader?: string;
  /** Documentation. Never dialled by anything, here or anywhere. */
  exampleUrl?: string;
  /** Where the author says conversations go, for the screen to compare against what is typed. */
  sendsConversationTo?: string;
};

export type TemplatePlan = {
  /** What a preview and an install agree they are talking about. */
  digest: string;
  connectors: ResolvedConnector[];
  components: ResolvedComponent[];
  skills: ResolvedSkill[];
  endpoint: ResolvedEndpoint;
  /**
   * The defaults, keyed by the slug the template names, ready to be handed straight back to
   * `installBotTemplate` as `slugDecisions`. A screen that changes one radio changes one entry.
   */
  slugDecisions: Record<string, SlugResolution>;
};

/**
 * `slug-2`, `slug-3`, … and still a slug the product can save.
 *
 * The base is trimmed rather than the suffix dropped when the two together would pass forty
 * characters, and the trim re-cuts a trailing hyphen, because `renewal-desk-…-` fails the format's
 * rule and a skill that fails it installs and is then uneditable through every screen.
 */
export function suffixedSlug(base: string, index: number): string | null {
  const tail = `-${index}`;
  const room = SLUG_LIMIT - tail.length;
  const trimmed = base.slice(0, Math.max(room, 0)).replace(/-+$/, "");
  if (!trimmed) return null;
  const candidate = `${trimmed}${tail}`;
  return TEMPLATE_SLUG.test(candidate) ? candidate : null;
}

/**
 * Resolve a template against this deployment. Reads only.
 *
 * The executor is the caller's, so an install can resolve on the transaction it is about to write
 * in rather than reading a snapshot on a second pooled connection — which would both deadlock under
 * a small pool and answer about a database a moment older than the one being written.
 */
export async function resolveBotTemplate(
  executor: TemplateReadExecutor,
  template: BotTemplate,
  options: {
    /** Whether this deployment has a Bot in the box. `config.managedAgent` decides. */
    managedAgent: boolean;
    /** The digest the caller already computed, so a preview and an install agree on one value. */
    digest: string;
  },
): Promise<TemplatePlan> {
  const connectorIds = [
    ...new Set(template.requests.connectors.map((connector) => connector.id)),
  ];
  const requestedRefs = [
    ...new Set(
      template.requests.connectors.flatMap((connector) =>
        connector.tools.map((tool) => tool.ref),
      ),
    ),
  ];
  const componentNames = [
    ...new Set(template.requests.components.map((component) => component.name)),
  ];
  const templateSlugs = template.skills.map((skill) => skill.slug);

  const serverRows =
    connectorIds.length === 0
      ? []
      : await executor
          .select({ id: mcpServers.id })
          .from(mcpServers)
          .where(inArray(mcpServers.id, connectorIds));
  const presentServers = new Set(serverRows.map((row) => row.id));

  /*
   * Narrowed to the servers actually named rather than reading the catalogue and filtering here, the
   * same shape `knownToolRefs` uses and for the same reason: a deployment aiming at a thousand tools
   * should not scan all of them to answer three.
   */
  const toolServers = [
    ...new Set(requestedRefs.map((ref) => ref.split("/")[0] ?? "")),
  ].filter(Boolean);
  const toolRows =
    toolServers.length === 0
      ? []
      : await executor
          .select({ serverId: mcpTools.serverId, name: mcpTools.name })
          .from(mcpTools)
          .where(inArray(mcpTools.serverId, toolServers));
  const presentTools = new Set(
    toolRows.map((row) => `${row.serverId}/${row.name}`),
  );

  const componentRows =
    componentNames.length === 0
      ? []
      : await executor
          .select({ name: components.name, published: components.published })
          .from(components)
          .where(inArray(components.name, componentNames));
  const presentComponents = new Map(
    componentRows.map((row) => [row.name, row.published]),
  );

  /*
   * Every slug this deployment already has among the ones the template names, with what each one
   * says. Read together rather than one query per skill, and read here rather than trusted from a
   * preview, because the whole point of the comparison is that it is about the database as it is.
   */
  const existingRows =
    templateSlugs.length === 0
      ? []
      : await executor
          .select({
            slug: skills.slug,
            instructions: skills.instructions,
          })
          .from(skills)
          .where(inArray(skills.slug, templateSlugs));
  const existing = new Map(
    existingRows.map((row) => [row.slug, row.instructions]),
  );
  const existingToolRows =
    existing.size === 0
      ? []
      : await executor
          .select({ skillId: skillTools.skillId, ref: skillTools.ref })
          .from(skillTools)
          .where(inArray(skillTools.skillId, [...existing.keys()]));
  const existingTools = new Map<string, string[]>();
  for (const row of existingToolRows) {
    existingTools.set(row.skillId, [
      ...(existingTools.get(row.skillId) ?? []),
      row.ref,
    ]);
  }

  /*
   * Every slug the deployment holds, not only the ones the template names, because a suffix search
   * probes names the template never mentioned. Read once for the whole plan, and only when something
   * actually collided — the ordinary import collides with nothing and should not read the table.
   */
  const allSlugRows =
    existing.size === 0
      ? []
      : await executor.select({ slug: skills.slug }).from(skills);
  /*
   * A working set rather than a fixed one. Two skills in the same template can suffix into the same
   * name — `desk` and `desk-2` both colliding gives `desk-2` twice — so each choice is added as it is
   * made, and the second skill walks past it.
   */
  const taken = new Set(allSlugRows.map((row) => row.slug));

  const paired = new Set(template.bot.skills);
  const resolvedSkills: ResolvedSkill[] = [];
  const slugDecisions: Record<string, SlugResolution> = {};

  for (const skill of template.skills) {
    const collides = existing.has(skill.slug);
    const identical =
      collides &&
      existing.get(skill.slug) === skill.instructions &&
      sameRefs(existingTools.get(skill.slug) ?? [], skill.tools);

    let suffixCandidate: string | null = null;
    if (collides) {
      for (let index = 2; index <= MAX_SUFFIX; index += 1) {
        const candidate = suffixedSlug(skill.slug, index);
        if (candidate && !taken.has(candidate)) {
          suffixCandidate = candidate;
          break;
        }
      }
    }

    const resolution: SlugResolution = !collides
      ? "suffix"
      : identical
        ? "reuse"
        : suffixCandidate
          ? "suffix"
          : "skip";

    /*
     * `suffix` is also what a slug nobody has taken resolves to, which reads oddly for a moment and
     * is the right shape: the resolution names what the installer does with the name, and for a free
     * name that is "write it as it stands". `installAs` is the value that matters, and a screen only
     * offers the radio when `collides` is true.
     */
    const installAs =
      resolution === "reuse"
        ? skill.slug
        : resolution === "skip"
          ? null
          : collides
            ? suffixCandidate
            : skill.slug;
    if (installAs) taken.add(installAs);

    resolvedSkills.push({
      slug: skill.slug,
      title: skill.title,
      collides,
      identical,
      resolution,
      installAs,
      suffixCandidate,
      paired: paired.has(skill.slug),
    });
    slugDecisions[skill.slug] = resolution;
  }

  const remote = template.bot.remote;
  const endpointRequired =
    template.bot.runtime === "remote" || !options.managedAgent;

  return {
    digest: options.digest,
    connectors: template.requests.connectors.map((connector) => ({
      id: connector.id,
      why: connector.why,
      verdict: presentServers.has(connector.id)
        ? ("available" as const)
        : ("unavailable" as const),
      tools: connector.tools.map((tool) => ({
        ref: tool.ref,
        why: tool.why,
        /*
         * Both rows, not either. A server that is connected but has never been refreshed advertises
         * no tools, and reporting its refs as available would tell the importer a grant is one click
         * away when the grant screen has nothing to list.
         */
        verdict:
          presentServers.has(connector.id) && presentTools.has(tool.ref)
            ? ("available" as const)
            : ("unavailable" as const),
      })),
    })),
    components: template.requests.components.map((component) => ({
      name: component.name,
      why: component.why,
      verdict: presentComponents.has(component.name)
        ? ("available" as const)
        : ("not_in_build" as const),
      published: presentComponents.get(component.name) ?? false,
    })),
    skills: resolvedSkills,
    endpoint: {
      required: endpointRequired,
      reason: !endpointRequired
        ? null
        : template.bot.runtime === "remote"
          ? ("remote" as const)
          : ("no_managed_agent" as const),
      requiresKey: remote?.requiresKey ?? false,
      ...(remote?.authHeader ? { authHeader: remote.authHeader } : {}),
      ...(remote?.exampleUrl ? { exampleUrl: remote.exampleUrl } : {}),
      ...(remote?.sendsConversationTo
        ? { sendsConversationTo: remote.sendsConversationTo }
        : {}),
    },
    slugDecisions,
  };
}

/** Two declaration sets are the same set, regardless of the order either was written in. */
function sameRefs(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const held = new Set(left);
  return right.every((ref) => held.has(ref));
}
