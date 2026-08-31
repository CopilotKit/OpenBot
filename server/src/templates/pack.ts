/**
 * A configured coworker, packed into a template somebody else can read.
 *
 * The judgement in this file is almost entirely about what does NOT come out the other side. A Bot on
 * a running deployment is a row with an id that decides which routes it answers on, an owner, a
 * visibility, an address, and a credential id naming a vault row that exists on this machine and
 * nowhere else. Every one of those is a fact about the deployment it was packed from rather than
 * about the coworker, so none of them travel, and the format has no field that could carry them
 * anyway: a template that named a host or a credential would fail to parse rather than be quietly
 * redacted.
 *
 * The stripping is REPORTED rather than performed quietly. `PackResult.stripped` is the interesting
 * half of an export — an author about to send this file to a stranger should be told in sentences
 * that the endpoint and the key reference were left behind, because otherwise the first thing they
 * learn about it is that the imported Bot does not work and they cannot tell why.
 *
 * Nothing here reads the database, the environment or the network. Packing is a pure function of a
 * profile and its attachments, so every refusal can be tested as one, and the same secret scanner
 * runs again on a draft an author has since edited by hand.
 */
import type { AgentProfile } from "../agents/profile-types";
import {
  BOT_TEMPLATE_FORMAT,
  type BotTemplate,
  type BotTemplateComponentRequest,
  type BotTemplateConnectorRequest,
  type BotTemplateRemote,
  type BotTemplateSkill,
  refuseHostileBytes,
  serializeBotTemplate,
  STRICT_BOUNDARY,
  TEMPLATE_LIMITS,
  TemplateRefusedError,
  type TemplateRuntime,
} from "../../../shared/bot-template";

/** A skill this coworker holds, as `skills` and `skill_tools` record it. */
export type PackSkill = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  /** `<serverId>/<toolName>` declarations. Declarations only, exactly as they are on the skill. */
  tools: string[];
};

/**
 * One of the Bot's MCP `plugin_grants` rows, read here to derive an ask and never to make one.
 *
 * The kind is written in prose rather than as the literal string the grant store uses, because the
 * property this module has to keep is that nothing under `server/src/templates/` ever writes an MCP
 * grant, and that property is guarded by a grep over this directory rather than by an argument.
 */
export type PackGrant = { ref: string };

export type PackInput = {
  profile: AgentProfile;
  /** The `agents.configuration` jsonb. Read for the endpoint and the auth record; neither travels. */
  configuration: Record<string, unknown>;
  skills: PackSkill[];
  /**
   * The Bot's MCP grants, which become the `requests` block and nothing else.
   *
   * A grant is a capability and capability does not travel. What a template may say is that this
   * coworker was working against Drive when it was packed, so an importer knows what to grant it if
   * they decide to.
   */
  grants: PackGrant[];
  /** Component names this Bot may use, which become requests for the same reason. */
  components: string[];
  /**
   * The auth header NAME, from `configuration.auth.header`. Never the value, which lives in the
   * vault and is not readable here at all.
   */
  authHeaderName?: string;
  /**
   * The address this deployment's own managed Bot answers on, when it has one.
   *
   * Needed because a managed coworker's configuration carries an endpoint too: `create` writes the
   * deployment's own AG-UI URL into `configuration.endpoint` for a Bot that runs in the box
   * (`profile-store.ts:277-312`), so the presence of an endpoint alone does not distinguish "runs on
   * this deployment" from "runs on somebody's own server". Without this, every Bot on a deployment
   * that has a managed agent would pack as `remote`, and every importer would be asked to type an
   * address for a coworker that should simply run in their box. The packer cannot look the value up
   * itself, because it reads nothing.
   */
  managedEndpoint?: string;
};

export type PackResult = {
  template: BotTemplate;
  /** What was left behind, in sentences, one per fact. */
  stripped: string[];
};

/**
 * The `why` a request carries when nobody has written one yet.
 *
 * THE AUTHOR EDITS THIS. `why` is the sentence an importer reads beside an ask, and on the consent
 * screen it is the only thing that can explain why a stranger's coworker wants access to their Drive.
 * The packer cannot know the reason: a grant row records that somebody granted a tool, never what
 * for. So the draft carries the one sentence that is true of every request it derives and leaves the
 * author to replace it. This is the whole reason export produces a draft to edit rather than a file
 * to download.
 */
const DRAFT_WHY = "Granted to this Bot on the deployment it was packed from.";

/**
 * The slug for a Bot whose name yields nothing a slug can be made of.
 *
 * A name written entirely in a script with no ASCII letters reduces to an empty string, and an empty
 * slug is a document the parser refuses. The fallback is deliberately one an author will notice and
 * change rather than one that looks finished.
 */
const UNNAMED_SLUG = "unnamed-bot";

/**
 * The rules `shared/bot-template.ts` enforces on the way back in, restated because it does not export
 * them.
 *
 * Duplicated constants are a place two files can drift apart, so the round-trip test — pack,
 * serialize, parse — is what keeps these honest: a copy that disagreed with the parser would produce
 * a draft that fails to import, and that test would fail before anybody shipped one.
 */
const TEMPLATE_SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const TOOL_REF = /^[^/\s]+\/[^/\s]+$/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

/** Sorted output, so packing the same Bot twice produces the same document and the same digest. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * A carried string, normalised and held to the limit the parser will hold it to.
 *
 * Checked here rather than left to the parser so the refusal names the Bot's own field while the
 * author is looking at the Bot. The alternative is a draft that serializes cleanly, travels, and is
 * refused on somebody else's deployment for a length nobody here was told about.
 */
function carried(value: string, field: string, max: number): string {
  const normalised = value.normalize("NFC").trim();
  if (!normalised) {
    throw new TemplateRefusedError(
      "missing_field",
      `${field} is empty, and a template cannot describe a coworker without it.`,
    );
  }
  if ([...normalised].length > max) {
    throw new TemplateRefusedError(
      "too_long",
      `${field} is longer than ${max} characters, which is the ceiling the template parser enforces. Shorten it on the Bot rather than exporting a draft no deployment can import.`,
    );
  }
  return normalised;
}

/** How the endpoint is recorded. `agents/profile-store.ts` owns the shape; this only reads it. */
function endpointIn(configuration: Record<string, unknown>): string | null {
  const endpoint = configuration.endpoint;
  return typeof endpoint === "string" && endpoint ? endpoint : null;
}

/** How a key is recorded. `agents/auth-header.ts` owns the shape: a header name and a vault row id. */
function authIn(
  configuration: Record<string, unknown>,
): { header: string; credentialId: string } | null {
  const auth = configuration.auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
  const { header, credentialId } = auth as {
    header?: unknown;
    credentialId?: unknown;
  };
  return typeof header === "string" && typeof credentialId === "string"
    ? { header, credentialId }
    : null;
}

/**
 * A Bot's name into the slug that names the file.
 *
 * Accents are decomposed and their marks dropped before anything else, so "Über Desk" becomes
 * "uber-desk" rather than "ber-desk". Everything else outside the alphabet becomes a hyphen, runs
 * collapse, and the result is cut to the format's ceiling and re-trimmed, because a cut can land on a
 * hyphen and a slug may not end on one.
 */
function deriveSlug(name: string): string {
  const folded = name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const slug = folded
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, TEMPLATE_LIMITS.SLUG)
    .replace(/-+$/g, "");
  return TEMPLATE_SLUG.test(slug) ? slug : UNNAMED_SLUG;
}

/**
 * The gallery's one-line description, drafted from what the Bot already says about itself.
 *
 * The first sentence of the role description is the closest thing a configured Bot has to a summary,
 * and it is the author's own words rather than something invented. A first sentence longer than the
 * ceiling is not truncated — a sentence cut in half reads as a mistake nobody made — so the title
 * stands in, and either way the author is expected to write a better one.
 */
function draftSummary(roleDescription: string, title: string): string {
  const [first] = roleDescription
    .normalize("NFC")
    .trim()
    .split(/(?<=[.!?])\s+/);
  const sentence = first?.trim() ?? "";
  return sentence && [...sentence].length <= TEMPLATE_LIMITS.SUMMARY
    ? sentence
    : title;
}

function packSkills(skills: PackSkill[]): BotTemplateSkill[] {
  const seen = new Set<string>();
  let refs = 0;

  return [...skills]
    .sort((left, right) => compare(left.slug, right.slug))
    .map((skill) => {
      const slug = carried(skill.slug, "a skill's slug", TEMPLATE_LIMITS.SLUG);
      /*
       * The tenant package's slug rule is looser than the API's and admits `x` and `find-`, so a
       * deployment can genuinely hold a skill whose slug a template may not carry. Refused by name
       * rather than dropped: a Bot silently exported without one of its skills is a Bot that imports
       * without the instructions it was working from.
       */
      if (!TEMPLATE_SLUG.test(slug)) {
        throw new TemplateRefusedError(
          "bad_slug",
          `The skill "${slug}" cannot travel: a template's slug rule is the Skills API's, which this slug predates. Rename the skill and export again.`,
        );
      }
      if (seen.has(slug)) {
        throw new TemplateRefusedError(
          "bad_slug",
          `The skill "${slug}" was given to this Bot twice, and a template may only define it once.`,
        );
      }
      seen.add(slug);

      const tools = [
        ...new Set(skill.tools.map((ref) => ref.normalize("NFC").trim())),
      ].sort(compare);
      for (const ref of tools) {
        if (!TOOL_REF.test(ref)) {
          throw new TemplateRefusedError(
            "bad_tool_ref",
            `The skill "${slug}" declares "${ref}", which is not written as serverId/toolName and could therefore never match a grant.`,
          );
        }
      }
      refs += tools.length;
      if (refs > TEMPLATE_LIMITS.TOOL_REFS) {
        throw new TemplateRefusedError(
          "too_many",
          `This Bot's skills declare more than ${TEMPLATE_LIMITS.TOOL_REFS} tools between them, which is more than a template may carry.`,
        );
      }

      return {
        slug,
        title: carried(
          skill.title,
          `skills.${slug}.title`,
          TEMPLATE_LIMITS.SKILL_TITLE,
        ),
        summary: carried(
          skill.summary,
          `skills.${slug}.summary`,
          TEMPLATE_LIMITS.SUMMARY,
        ),
        instructions: carried(
          skill.instructions,
          `skills.${slug}.instructions`,
          TEMPLATE_LIMITS.INSTRUCTIONS,
        ),
        tools,
      };
    });
}

/**
 * Grants and component names into the ask.
 *
 * Grouped by the `<serverId>` half of each ref, because that is how the consent screen reads them and
 * how an administrator satisfies them: one connector at a time, on the screen that already decides
 * connectors. Nothing here is written as a permission, and nothing downstream may treat it as one.
 */
function packRequests(input: PackInput): {
  connectors: BotTemplateConnectorRequest[];
  components: BotTemplateComponentRequest[];
} {
  const byServer = new Map<string, Set<string>>();
  for (const grant of input.grants) {
    const ref = grant.ref.normalize("NFC").trim();
    if (!TOOL_REF.test(ref)) {
      throw new TemplateRefusedError(
        "bad_tool_ref",
        `This Bot holds a grant for "${ref}", which is not written as serverId/toolName and cannot be expressed as a request.`,
      );
    }
    const serverId = ref.slice(0, ref.indexOf("/"));
    const refs = byServer.get(serverId) ?? new Set<string>();
    refs.add(ref);
    byServer.set(serverId, refs);
  }

  const connectors = [...byServer.entries()]
    .sort(([left], [right]) => compare(left, right))
    .map(([serverId, refs]) => ({
      id: carried(
        serverId,
        `the connector "${serverId}"`,
        TEMPLATE_LIMITS.SLUG,
      ),
      why: DRAFT_WHY,
      tools: [...refs].sort(compare).map((ref) => ({ ref, why: DRAFT_WHY })),
    }));

  const components = [
    ...new Set(input.components.map((name) => name.normalize("NFC").trim())),
  ]
    .sort(compare)
    .map((name) => ({
      name: carried(name, `the component "${name}"`, 80),
      why: DRAFT_WHY,
    }));

  const total =
    connectors.length +
    components.length +
    connectors.reduce((sum, connector) => sum + connector.tools.length, 0);
  if (total > TEMPLATE_LIMITS.REQUEST_ENTRIES) {
    throw new TemplateRefusedError(
      "too_many",
      `This Bot asks for ${total} things and a template may ask for ${TEMPLATE_LIMITS.REQUEST_ENTRIES}. A request list nobody reads to the end is not consent.`,
    );
  }

  return { connectors, components };
}

/**
 * What was left behind, said out loud.
 *
 * Two kinds of entry, and the difference is deliberate. A fact that is true of every export — an id
 * is minted, an owner becomes the importer, a visibility becomes private — is listed unconditionally,
 * because it states the rule. A fact about something this Bot actually holds — a key, an address, a
 * package mark — is listed only when it holds one, because telling an author that their Bot's key was
 * stripped when their Bot has no key teaches them the wrong thing about what a template carries.
 */
function strippedFrom(
  input: PackInput,
  endpoint: string | null,
  hasAuth: boolean,
  seedReplaced: boolean,
): string[] {
  const stripped: string[] = [
    "agents.id: this Bot's id, and an import mints a fresh one. An id decides which deployment routes a Bot answers on, so a template that carried one could name a route it is not entitled to.",
    "agent_profiles.visibility: an imported Bot is private, and making it public is an ordinary later edit by its new owner.",
    "agent_profiles.deleted_at: this deployment's lifecycle state for this Bot, which says nothing about the coworker.",
    "agent_preferences: whether a person here hid this Bot. Per-person state about the people on this deployment.",
  ];

  if (input.profile.systemOwned) {
    stripped.push(
      "agents.package_id: the mark that makes this Bot system-owned. Carried, it would forge a package Bot on the importing deployment and leave it unmanageable there.",
    );
  }
  if (input.profile.ownerUserId) {
    stripped.push(
      "agent_profiles.owner_user_id: who owns this Bot here. An imported Bot is owned by whoever imported it.",
    );
  }
  if (input.profile.hasCallbackToken) {
    stripped.push(
      "agents.callback_token_hash: the credential this Bot calls tools back with. An imported Bot arrives with none, which is what stops it calling anything back until somebody issues one.",
    );
  }
  if (endpoint) {
    stripped.push(
      "configuration.endpoint: the address this Bot runs on. The format has no field for one: the importer types an address, and it is checked against their deployment's allowlist rather than against this one's.",
    );
  }
  if (hasAuth) {
    stripped.push(
      "configuration.auth.credentialId: the vault row holding this Bot's key. It is an id from this deployment pointing at a row that is not on the importing one, and the key itself is never readable here at all.",
    );
  }
  if (seedReplaced) {
    stripped.push(
      "agent_profiles.avatar_seed: this Bot's seed is its own id, which is what create writes today. A style token derived from the name travels in its place, because an avatar seed is a style token and an id is not something a template may carry.",
    );
  }
  /*
   * A package Bot's standing prompt, which the format has no field for in v1 and which is therefore
   * the one carried thing that goes missing rather than being replaced. Exporting a shipped Bot is
   * deliberately allowed — they are the most template-worthy things in the product — so the author
   * has to be told plainly that its behaviour did not come with it and has to be written into the
   * draft's own prose by hand.
   */
  if (
    typeof input.configuration.systemPrompt === "string" &&
    input.configuration.systemPrompt.trim()
  ) {
    stripped.push(
      "configuration.systemPrompt: the standing prompt this Bot runs on. A template says what a coworker is in role_description and skill instructions, so a Bot built on a system prompt is not a faithful round trip and the draft needs that behaviour written into its prose.",
    );
  }
  if (input.skills.length) {
    stripped.push(
      "skills.owner_user_id, skills.installed_by and skills.declared_by: who wrote and installed each skill here. Imported skills belong to whoever imports them.",
    );
  }

  return stripped;
}

/**
 * A coworker into the draft of a template.
 *
 * Throws `TemplateRefusedError` when this Bot cannot be expressed as one — a skill slug the format
 * does not admit, prose past a ceiling, a role description carrying an environment reference — and
 * `SecretInTemplateError` when its text carries something shaped like a credential.
 */
export function packBotTemplate(input: PackInput): PackResult {
  const name = carried(
    input.profile.name,
    "the Bot's name",
    TEMPLATE_LIMITS.NAME,
  );
  const title = carried(
    input.profile.title,
    "the Bot's title",
    TEMPLATE_LIMITS.TITLE,
  );
  const roleDescription = carried(
    input.profile.roleDescription,
    "the Bot's role description",
    TEMPLATE_LIMITS.ROLE_DESCRIPTION,
  );

  const endpoint = input.profile.endpoint ?? endpointIn(input.configuration);
  const auth = authIn(input.configuration);
  const hasAuth = input.profile.hasAuth || auth !== null;

  /*
   * Remote means this coworker runs somewhere the importing deployment has never heard of, and the
   * only honest signal for that is an endpoint that is not this deployment's own. See
   * `PackInput.managedEndpoint` for why the presence of an endpoint is not the signal by itself.
   */
  const runtime: TemplateRuntime =
    endpoint !== null && endpoint !== input.managedEndpoint
      ? "remote"
      : "managed";

  const headerName = input.authHeaderName ?? auth?.header;
  if (headerName !== undefined && !HEADER_NAME.test(headerName)) {
    throw new TemplateRefusedError(
      "bad_type",
      `"${headerName}" is stored as this Bot's auth header name and is not a header name, so it cannot travel as one.`,
    );
  }

  /*
   * A remote template carries the header NAME and the fact that a key is wanted, and nothing else
   * about where it runs. Not `example_url`, and not `sends_conversation_to`: both are hostnames, and
   * this Bot's hostname is the address of a server on the deployment being packed. Stripping the
   * endpoint and then writing its host into a documentation field beside it would put back exactly
   * what the strip was for. An author who means the address to be public adds it by hand, which is a
   * deliberate act, and the consent screen renders it as the claim it is.
   */
  const remote: BotTemplateRemote | undefined =
    runtime === "remote"
      ? { authHeader: headerName, requiresKey: hasAuth }
      : undefined;

  const skills = packSkills(input.skills);
  const requests = packRequests(input);

  const slug = deriveSlug(name);
  const storedSeed = input.profile.avatarSeed.normalize("NFC").trim();
  /*
   * `create` sets a new Bot's avatar seed to its own agent id (`profile-store.ts:343`), which is both
   * an id and a string the format's slug rule refuses. Where the stored seed is a usable style token
   * it travels unchanged, so a Bot keeps its face; where it is an id, the slug stands in and the
   * substitution is reported rather than made silently.
   */
  const seedTravels =
    storedSeed.length <= TEMPLATE_LIMITS.SLUG && TEMPLATE_SLUG.test(storedSeed);

  const template: BotTemplate = {
    format: BOT_TEMPLATE_FORMAT,
    template: {
      slug,
      // The author's string, which nothing reads. A draft carries one so there is a field to edit
      // rather than a key to discover.
      version: "1.0",
      summary: draftSummary(roleDescription, title),
      /*
       * No `author`, `source`, `category` or `license`. `template.author` is a claim, and the packer
       * is not the one entitled to make it: filling it from the owner would put a person's name into
       * a file that travels, on their behalf, because they pressed Export. A licence is a decision
       * about somebody else's words.
       *
       * `category` is omitted because a Bot on a deployment has no category to carry — nothing in
       * `agents` or `agent_profiles` records what kind of work a coworker does, so there is no value
       * here to pack. Deriving one from the name or the role description would be the packer
       * guessing, and a guess in this field is a grouping the gallery then files a stranger's
       * template under on the author's behalf. All are keys the author adds to the draft.
       */
    },
    bot: {
      name,
      title,
      roleDescription,
      avatarSeed: seedTravels ? storedSeed : slug,
      runtime,
      skills: skills.map((skill) => skill.slug),
      remote,
    },
    skills,
    requests,
    /*
     * The strictest ceiling the vocabulary can express, every time, whatever this Bot could do here.
     *
     * The packer cannot know what the Bot actually used: nothing records that a coworker ever ran a
     * shell command or read a file, and the action policy it ran under is one row for this whole
     * deployment rather than a fact about this coworker. Deriving a boundary from what it was ALLOWED
     * would export a stock deployment's `allow: ["true"]` as a coworker's requirements, and that
     * permissiveness would then travel to everyone who imports the file. So the draft says the least
     * the format can say, and widening it is a deliberate edit by an author who knows what the Bot
     * needs. Spread rather than shared, so nothing downstream can mutate the constant every other
     * template also reads.
     */
    boundary: {
      ...STRICT_BOUNDARY,
      navigateHosts: [...STRICT_BOUNDARY.navigateHosts],
    },
  };

  /*
   * The draft has to be a document this same deployment could import, checked by running the byte
   * refusals over it rather than by arguing that it is. A role description somebody typed `${` into
   * is otherwise exported cleanly and refused on every deployment it reaches, including this one, and
   * the author hears about it from a stranger.
   *
   * Before the secret scan, deliberately: an invisible codepoint sitting inside a key is exactly what
   * would carry a credential past a scanner reading it as text.
   */
  refuseHostileBytes(serializeBotTemplate(template));

  /*
   * The scan is not the caller's to remember. A warning at pack time is a warning an author clicks
   * through, and an export route that forgot to call the scanner would ship keys with no error at
   * all; calling it here means the only way to get a template out of this module is to get one that
   * has been scanned. It stays exported because a draft edited by hand afterwards has to be scanned
   * again.
   */
  refuseSecrets(template);

  return {
    template,
    stripped: strippedFrom(input, endpoint, hasAuth, !seedTravels),
  };
}

/** A template that carries something shaped like a credential, and the field it is in. */
export class SecretInTemplateError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "SecretInTemplateError";
    this.field = field;
  }
}

/**
 * The shapes a credential takes, each recognised by its issuer's own prefix.
 *
 * Prefixes are anchored against a preceding alphanumeric so that ordinary prose is not a match: the
 * three characters that open an OpenAI key also sit in the middle of "task-management-system", and a
 * scanner that refused that would be a scanner authors learn to work around.
 */
const SECRET_SHAPES: { what: string; pattern: RegExp }[] = [
  {
    what: "an API key of the sk- family",
    pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/,
  },
  {
    what: "a GitHub token",
    pattern:
      /(?<![A-Za-z0-9])(?:gh[pous]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  },
  {
    what: "a Slack token",
    pattern: /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    what: "an AWS access key id",
    pattern: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/,
  },
  {
    what: "a JSON web token",
    pattern:
      /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_=-]{10,}\.[A-Za-z0-9_=-]{10,}\.[A-Za-z0-9_=-]{8,}/,
  },
  {
    what: "an address carrying a password",
    pattern: /https?:\/\/[^\s/:@]+:[^\s/@]+@/,
  },
  {
    what: "a private key",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
  },
];

/**
 * The catch-all for a credential with no recognisable prefix.
 *
 * A long run of key-alphabet characters is not enough on its own: "check-the-renewal-date-and-notice-period"
 * is forty characters of it and is a sentence. Two things have to be true together — the run has to
 * look like it was generated rather than typed, which means upper case, lower case and a digit or one
 * of base64's own characters, and a word that announces a credential has to be sitting next to it.
 * That pairing is what a leaked secret in prose actually looks like, and neither half alone is.
 */
const KEY_RUN = /[A-Za-z0-9+/=_-]{32,}/g;
const KEY_WORD = /\b(?:key|token|secret|password|passphrase|credential)s?\b/i;
const KEY_WORD_WINDOW = 48;

function looksGenerated(run: string): boolean {
  if (/[+/=]/.test(run)) return true;
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);
}

function secretShapeIn(value: string): string | null {
  for (const { what, pattern } of SECRET_SHAPES) {
    if (pattern.test(value)) return what;
  }

  KEY_RUN.lastIndex = 0;
  for (const match of value.matchAll(KEY_RUN)) {
    const run = match[0];
    if (!looksGenerated(run)) continue;
    const index = match.index ?? 0;
    const before = value.slice(Math.max(0, index - KEY_WORD_WINDOW), index);
    const after = value.slice(
      index + run.length,
      index + run.length + KEY_WORD_WINDOW,
    );
    if (KEY_WORD.test(before) || KEY_WORD.test(after)) {
      return "a credential, from a run of key-shaped characters beside a word that announces one";
    }
  }

  return null;
}

/** A camelCase field back to the name it is written under in the file the author reads. */
function fileKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Every string in the document, with the path it is written at.
 *
 * Walked structurally rather than field by field, so a key added to the format later is scanned
 * because it is there rather than because somebody remembered to add it to a list. A scanner that
 * fails open on a new field is the failure this shape exists to prevent.
 */
function* everyString(
  value: unknown,
  path: string,
): Generator<[string, string]> {
  if (typeof value === "string") {
    yield [path, value];
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      yield* everyString(entry, `${path}[${index}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const name = fileKey(key);
      yield* everyString(entry, path ? `${path}.${name}` : name);
    }
  }
}

/**
 * Refuse a template that carries something shaped like a credential.
 *
 * REFUSES RATHER THAN WARNS. A warning on an export screen is a sentence between an author and the
 * thing they are trying to do, and it is clicked through; a key that reaches a file reaches everyone
 * the file reaches, and there is no taking it back once it is in somebody's paste buffer. A false
 * positive costs an author one edit, which is the trade being made deliberately.
 *
 * The value is never repeated in the message. The refusal is rendered on a screen, put in a log and
 * carried by an audit row, and a scanner that quoted the secret it found would put the secret in all
 * three.
 */
export function refuseSecrets(template: BotTemplate): void {
  for (const [field, value] of everyString(template, "")) {
    const shape = secretShapeIn(value);
    if (shape) {
      throw new SecretInTemplateError(
        field,
        `${field} carries something shaped like ${shape}, so this Bot was not packed. A template is a file that travels, and nothing in it is ever a secret. Take the value out of the Bot and export again. It is deliberately not quoted here, or this refusal would be the next place it leaks.`,
      );
    }
  }
}
