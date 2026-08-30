/**
 * The Bot template format: one file describing one coworker.
 *
 * Configuration travels; capability does not. A template carries a coworker's identity and its
 * prose, the skills it depends on, the capabilities it *asks* for, and a ceiling on what it may do.
 * It carries no id, no endpoint URL, no credential, no MCP grant, no component source and no policy
 * rule, because none of those are fields here — a document containing one fails to parse rather than
 * being quietly stripped, so an author who tried to ship a key is told, and a reviewer reading the
 * file is not reading a redacted copy of something larger.
 *
 * The vocabulary is deliberately the tenant package's (`role_description`, `avatar_seed`, and a
 * skill's `slug`/`title`/`summary`/`instructions`/`tools`), so anybody who has read
 * `examples/fintech/` can read a template. It diverges on three points, and each is a security
 * decision rather than a preference:
 *
 *   1. STRICT PARSING. `validateTenantPackage` reads the keys it knows and ignores the rest, which is
 *      right for an operator's own directory: a stale key from an older product version should not
 *      stop a deployment booting. It is wrong for a stranger's file, where an ignored key is a key
 *      the reviewer's eye slid over and the parser agreed to. Here an unrecognised key anywhere is a
 *      refusal naming it.
 *
 *   2. NO ENVIRONMENT INTERPOLATION, AT ALL. `expandEnvironment` substitutes textually, before the
 *      YAML is parsed, out of the server's own environment. In a package that is how one file serves
 *      a laptop, a staging stack and production. In a stranger's file it is an exfiltration
 *      primitive: a `role_description` naming the deployment's key-encryption key or computer token
 *      would be expanded, stored, shown to a model and readable afterwards. There is no allowlist of
 *      variable names and no escaping — the opening sequence is refused wherever it appears, and it
 *      is checked against the raw bytes rather than the parsed document, so a comment cannot carry
 *      it either.
 *
 *   3. THE API'S SLUG RULE, not the package's. The package's admits `x` and `find-`, both of which
 *      install cleanly and are then permanently uneditable through the product, because the Skills
 *      API refuses to save what the package was allowed to create.
 *
 * Nothing in this file reads the database, the environment or the network. It is the whole of what a
 * template *is*, so the refusals can be tested as pure functions and the same parse runs at preview
 * and again at install.
 */
import { parse, stringify } from "yaml";

/**
 * The format version, and a hard gate rather than a hint.
 *
 * A future format that means something different by the same key names must not be read leniently by
 * an older deployment. There is one accepted value; anything else is refused and names itself.
 */
export const BOT_TEMPLATE_FORMAT = 1;

/** Why a document was refused. The wire carries the code; the message is for the person. */
export type TemplateRefusal =
  | "format_version"
  | "unknown_key"
  | "missing_field"
  | "bad_type"
  | "interpolation"
  | "invisible_character"
  | "too_large"
  | "too_many"
  | "too_long"
  | "bad_slug"
  | "bad_tool_ref"
  | "bad_hostname"
  | "bad_url"
  | "unknown_skill"
  | "forbidden_field"
  | "malformed_yaml";

export class TemplateRefusedError extends Error {
  readonly reason: TemplateRefusal;
  constructor(reason: TemplateRefusal, message: string) {
    super(message);
    this.name = "TemplateRefusedError";
    this.reason = reason;
  }
}

export type TemplateRuntime = "managed" | "remote";
export type TemplateShell = "never" | "permitted";
export type TemplateFiles = "none" | "read_only" | "read_write";
export type TemplateBrowser = "none" | "read_only" | "full";
export type TemplateMcp = "none" | "read_only" | "read_write";

export type BotTemplateRemote = {
  /**
   * The header NAME only. `auth-header.ts` already keeps it in unencrypted metadata because a header
   * name is not a secret; the value never travels and is typed by the importer into their own vault.
   */
  authHeader?: string;
  /** Whether the importer will be asked for a key. A claim, not a capability. */
  requiresKey: boolean;
  /** Documentation for the person typing the address. Never dialled by anything here. */
  exampleUrl?: string;
  /** Where the author says conversations go. Shown on the consent screen, and compared with what was typed. */
  sendsConversationTo?: string;
};

export type BotTemplateBot = {
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed?: string;
  runtime: TemplateRuntime;
  /** Slugs, every one of which this same file must define. */
  skills: string[];
  remote?: BotTemplateRemote;
};

export type BotTemplateSkill = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  /** `<serverId>/<toolName>` declarations. Not grants, and deliberately not checked against anything. */
  tools: string[];
};

export type BotTemplateToolRequest = { ref: string; why: string };
export type BotTemplateConnectorRequest = {
  id: string;
  why: string;
  tools: BotTemplateToolRequest[];
};
export type BotTemplateComponentRequest = { name: string; why: string };

export type BotTemplateRequests = {
  connectors: BotTemplateConnectorRequest[];
  components: BotTemplateComponentRequest[];
};

export type BotTemplateBoundary = {
  shell: TemplateShell;
  files: TemplateFiles;
  browser: TemplateBrowser;
  /** Exact hostnames. Compiled to equality, never to a pattern. */
  navigateHosts: string[];
  mcp: TemplateMcp;
};

export type BotTemplateMeta = {
  slug: string;
  version?: string;
  /** A CLAIM. Rendered as one, never verified, and never used to decide anything. */
  author?: string;
  source?: string;
  summary: string;
  license?: string;
};

export type BotTemplate = {
  format: typeof BOT_TEMPLATE_FORMAT;
  template: BotTemplateMeta;
  bot: BotTemplateBot;
  skills: BotTemplateSkill[];
  requests: BotTemplateRequests;
  boundary: BotTemplateBoundary;
  notes?: string;
};

/**
 * What an absent `boundary:` block means.
 *
 * The strictest thing the vocabulary can say, rather than the most permissive. An author who did not
 * write a boundary did not decide one, and the safe reading of "did not decide" is not "may do
 * anything" — that is the reading the shipped action policy already gives every Bot, and the whole
 * point of this block is to be able to say less than that for one Bot.
 *
 * `mcp` is the exception and is `read_only` rather than `none`, because an MCP grant is refused by
 * absence anyway: a ceiling of `none` over a floor of nothing-granted expresses the same thing twice
 * and would have to be widened by hand on every template that names a connector, which is most of
 * them. The export path writes this block out explicitly so the author sees it and widens what the
 * Bot actually needs, which is the reason export produces a draft rather than a download.
 */
export const STRICT_BOUNDARY: BotTemplateBoundary = {
  shell: "never",
  files: "none",
  browser: "none",
  navigateHosts: [],
  mcp: "read_only",
};

/**
 * Ceilings, so one file cannot be a denial of service against the person reading it.
 *
 * `INSTRUCTIONS` is bounded here because the Skills API checks that instructions are present and
 * nothing more. A template is the first path by which somebody else's unbounded text reaches that
 * column, so the bound is introduced rather than assumed to exist.
 */
export const TEMPLATE_LIMITS = {
  DOCUMENT_BYTES: 128 * 1024,
  SKILLS: 25,
  TOOL_REFS: 40,
  REQUEST_ENTRIES: 40,
  NAME: 80,
  TITLE: 120,
  ROLE_DESCRIPTION: 1000,
  SKILL_TITLE: 120,
  SUMMARY: 300,
  INSTRUCTIONS: 8000,
  WHY: 300,
  NOTES: 4000,
  SLUG: 40,
  HOSTS: 20,
  URL: 200,
} as const;

/** The Skills API's rule, not the tenant package's looser one. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
/** The one shape a declaration and a grant share. Anything else could never match a grant. */
const TOOL_REF = /^[^/\s]+\/[^/\s]+$/;
/** A plain hostname. No scheme, no path, no port, no wildcard — it compiles to an equality test. */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Codepoints that can hide a payload from every surface a human reviews with.
 *
 * Format characters, private-use areas, bidirectional overrides, zero-width joiners and tag
 * characters render as nothing in an editor, a terminal and a diff alike, so a consent screen
 * showing a role description "verbatim" would be showing text the reader cannot see all of. This is
 * the GlassWorm vector, and a review control that can be made invisible is not a control.
 *
 * Built from escapes rather than written literally, because a source file containing these
 * characters has the same problem it is here to solve. Checked against the raw bytes, so it covers
 * keys, values and comments together. Tab, newline and carriage return are the three controls a YAML
 * file legitimately contains and the only ones permitted.
 */
const INVISIBLE = new RegExp(
  [
    "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]",
    "[\\u00AD\\u061C\\u180E]",
    "[\\u200B-\\u200F]",
    "[\\u202A-\\u202E]",
    "[\\u2060-\\u2064]",
    "[\\u2066-\\u2069]",
    "[\\uFEFF\\uFFF9-\\uFFFB]",
    "[\\uE000-\\uF8FF]",
    "[\\uDB80-\\uDBBF][\\uDC00-\\uDFFF]",
    "\\uDB40[\\uDC00-\\uDFFF]",
  ].join("|"),
);

/**
 * The two characters that open an environment reference in a tenant package file.
 *
 * A plain string rather than a template literal, where the sequence has no meaning and is simply the
 * two characters it looks like.
 */
const INTERPOLATION_OPEN = "${";

/**
 * Key names a template may never carry, checked by name before anything else looks at the document.
 *
 * These are all refused by the unknown-key rule anyway. They are named separately so that a document
 * carrying one is told *why*: "a template never carries a credential" is a sentence an author can
 * act on, where "unknown key: credential_secret_ref" reads like a typo and invites them to try
 * another spelling.
 */
const FORBIDDEN_KEYS = new Map<string, string>([
  [
    "auth_value",
    "a template never carries a key; the importer types it into their own vault",
  ],
  ["credential", "a template never carries a credential"],
  [
    "credential_id",
    "a credential id from another deployment points at nothing here",
  ],
  ["credential_secret_ref", "a template never carries a credential reference"],
  ["callback_token", "a callback token is per-deployment credential material"],
  ["endpoint", "a template never names a host; the importer types the address"],
  ["url", "a template never names a host; the importer types the address"],
  ["package_id", "carrying a package id would forge a system-owned Bot"],
  ["owner_user_id", "an imported Bot is owned by whoever imported it"],
  ["visibility", "an imported Bot is private until its owner says otherwise"],
  [
    "system_prompt",
    "behaviour goes in role_description and skill instructions",
  ],
  ["deny", "a template never writes a policy rule"],
  ["allow", "a template never writes a policy rule"],
  ["components", "a template never carries component source"],
]);

function refuse(reason: TemplateRefusal, message: string): never {
  throw new TemplateRefusedError(reason, message);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse("bad_type", `${where} must be a block of keys`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) refuse("bad_type", `${where} must be a list`);
  return value;
}

/**
 * Every key in this block has to be one we know.
 *
 * The check that makes strict parsing strict, applied at each level rather than once at the top,
 * because a stranger's unknown key three levels down is exactly as unread as one at the root.
 *
 * A key legitimate HERE is accepted before the forbidden-name table is consulted, and the order
 * matters: those names are only meaningful as a better message for a key that was going to be
 * refused anyway. Consulted first, the table would refuse `requests.components` — the block that
 * exists so a template can *ask* for a component by name — on the grounds that a template never
 * carries component source, which is true and is about a different key of the same name.
 */
function onlyKnownKeys(
  block: Record<string, unknown>,
  known: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(block)) {
    if (known.includes(key)) continue;
    const forbidden = FORBIDDEN_KEYS.get(key);
    if (forbidden) {
      refuse("forbidden_field", `${where}.${key} is not allowed: ${forbidden}`);
    }
    refuse(
      "unknown_key",
      `${where}.${key} is not part of the Bot template format. Known keys here: ${known.join(", ")}.`,
    );
  }
}

function text(
  block: Record<string, unknown>,
  key: string,
  where: string,
  max: number,
): string {
  const value = block[key];
  if (typeof value !== "string" || !value.trim()) {
    refuse("missing_field", `${where}.${key} must be a non-empty string`);
  }
  const normalised = value.normalize("NFC");
  if ([...normalised].length > max) {
    refuse("too_long", `${where}.${key} is longer than ${max} characters`);
  }
  return normalised;
}

function optionalText(
  block: Record<string, unknown>,
  key: string,
  where: string,
  max: number,
): string | undefined {
  if (block[key] === undefined || block[key] === null) return undefined;
  return text(block, key, where, max);
}

/**
 * A link a template may show a person, and the narrow shape it is allowed to take.
 *
 * `source` and `example_url` are documentation: nothing here or anywhere else fetches them. They are
 * still attacker-controlled text that ends up beside a Bot's name on a consent screen, so they are
 * held to https and to a plain host, and the surface renders them as text rather than as anchors. A
 * template cannot put a clickable `javascript:` or a credential-carrying `https://user:pass@host` in
 * front of somebody who is in the middle of deciding whether to trust it.
 */
function optionalHttpsUrl(
  block: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = optionalText(block, key, where, TEMPLATE_LIMITS.URL);
  if (value === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    refuse("bad_url", `${where}.${key} must be an https:// address`);
  }
  if (parsed.protocol !== "https:") {
    refuse(
      "bad_url",
      `${where}.${key} must be an https:// address, not ${parsed.protocol}`,
    );
  }
  if (parsed.username || parsed.password) {
    refuse(
      "bad_url",
      `${where}.${key} must not carry a credential in the address`,
    );
  }
  if (!HOSTNAME.test(parsed.hostname.toLowerCase())) {
    refuse("bad_url", `${where}.${key} must name a plain host`);
  }
  return value;
}

function choice<T extends string>(
  block: Record<string, unknown>,
  key: string,
  where: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  const value = block[key];
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    refuse(
      "missing_field",
      `${where}.${key} must be one of ${allowed.join(", ")}`,
    );
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    refuse(
      "bad_type",
      `${where}.${key} must be one of ${allowed.join(", ")}, not ${String(value)}`,
    );
  }
  return value as T;
}

function strings(value: unknown, where: string, max: number): string[] {
  const entries = list(value, where);
  if (entries.length > max)
    refuse("too_many", `${where} has more than ${max} entries`);
  return entries.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      refuse("bad_type", `${where}[${index}] must be a non-empty string`);
    }
    return entry.normalize("NFC");
  });
}

/**
 * The refusals that read the file as bytes rather than as a document.
 *
 * Before `parse`, deliberately. Interpolation and invisible characters are properties of the text a
 * person reviewed, and a YAML parser would drop comments and normalise escapes out from under both
 * checks — the byte the reviewer saw is the byte that has to be checked.
 */
export function refuseHostileBytes(source: string): void {
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > TEMPLATE_LIMITS.DOCUMENT_BYTES) {
    refuse(
      "too_large",
      `The document is ${bytes} bytes and the limit is ${TEMPLATE_LIMITS.DOCUMENT_BYTES}`,
    );
  }

  const interpolation = source.indexOf(INTERPOLATION_OPEN);
  if (interpolation >= 0) {
    const line = source.slice(0, interpolation).split("\n").length;
    refuse(
      "interpolation",
      `The document contains an environment reference on line ${line}. A Bot template is never expanded against this deployment's environment, and the sequence is refused rather than ignored, so that a file written to be expanded somewhere else cannot arrive here looking harmless.`,
    );
  }

  const invisible = INVISIBLE.exec(source);
  if (invisible) {
    const line = source.slice(0, invisible.index).split("\n").length;
    const codepoint = source.codePointAt(invisible.index) ?? 0;
    refuse(
      "invisible_character",
      `The document contains U+${codepoint.toString(16).toUpperCase().padStart(4, "0")} on line ${line}, which renders as nothing in an editor, a terminal and a diff alike. A template you cannot fully see is one you cannot consent to.`,
    );
  }
}

const META_KEYS = [
  "slug",
  "version",
  "author",
  "source",
  "summary",
  "license",
] as const;
const BOT_KEYS = [
  "name",
  "title",
  "role_description",
  "avatar_seed",
  "runtime",
  "skills",
  "remote",
] as const;
const REMOTE_KEYS = [
  "auth_header",
  "requires_key",
  "example_url",
  "sends_conversation_to",
] as const;
const SKILL_KEYS = [
  "slug",
  "title",
  "summary",
  "instructions",
  "tools",
] as const;
const REQUEST_KEYS = ["connectors", "components"] as const;
const CONNECTOR_KEYS = ["id", "why", "tools"] as const;
const CONNECTOR_TOOL_KEYS = ["ref", "why"] as const;
const COMPONENT_KEYS = ["name", "why"] as const;
const BOUNDARY_KEYS = [
  "shell",
  "files",
  "browser",
  "navigate_hosts",
  "mcp",
] as const;
const ROOT_KEYS = [
  "openbot_template",
  "template",
  "bot",
  "skills",
  "requests",
  "boundary",
  "notes",
] as const;

function parseMeta(value: unknown): BotTemplateMeta {
  const block = record(value, "template");
  onlyKnownKeys(block, META_KEYS, "template");
  const slug = text(block, "slug", "template", TEMPLATE_LIMITS.SLUG);
  if (!SLUG.test(slug)) {
    refuse(
      "bad_slug",
      `template.slug "${slug}" must be lowercase letters, digits and hyphens, at least two characters, and must not start or end with a hyphen`,
    );
  }
  return {
    slug,
    version: optionalText(block, "version", "template", 40),
    author: optionalText(block, "author", "template", 80),
    source: optionalHttpsUrl(block, "source", "template"),
    summary: text(block, "summary", "template", TEMPLATE_LIMITS.SUMMARY),
    license: optionalText(block, "license", "template", 40),
  };
}

function parseRemote(value: unknown): BotTemplateRemote {
  const block = record(value, "bot.remote");
  onlyKnownKeys(block, REMOTE_KEYS, "bot.remote");

  const requiresKey = block.requires_key;
  if (requiresKey !== undefined && typeof requiresKey !== "boolean") {
    refuse("bad_type", "bot.remote.requires_key must be true or false");
  }

  const authHeader = optionalText(block, "auth_header", "bot.remote", 80);
  if (authHeader && !/^[A-Za-z0-9-]+$/.test(authHeader)) {
    refuse(
      "bad_type",
      `bot.remote.auth_header "${authHeader}" is not a header name`,
    );
  }

  const sendsTo = optionalText(
    block,
    "sends_conversation_to",
    "bot.remote",
    253,
  );
  if (sendsTo && !HOSTNAME.test(sendsTo.toLowerCase())) {
    refuse(
      "bad_hostname",
      `bot.remote.sends_conversation_to "${sendsTo}" must be a plain hostname, so the consent screen can compare it with the address that is actually typed`,
    );
  }

  return {
    authHeader,
    requiresKey: requiresKey === true,
    exampleUrl: optionalHttpsUrl(block, "example_url", "bot.remote"),
    sendsConversationTo: sendsTo?.toLowerCase(),
  };
}

function parseBot(value: unknown): BotTemplateBot {
  const block = record(value, "bot");
  onlyKnownKeys(block, BOT_KEYS, "bot");

  const runtime = choice(block, "runtime", "bot", [
    "managed",
    "remote",
  ] as const);
  const avatarSeed = optionalText(
    block,
    "avatar_seed",
    "bot",
    TEMPLATE_LIMITS.SLUG,
  );
  if (avatarSeed && !SLUG.test(avatarSeed)) {
    refuse(
      "bad_slug",
      `bot.avatar_seed "${avatarSeed}" must be lowercase letters, digits and hyphens`,
    );
  }
  if (runtime === "managed" && block.remote !== undefined) {
    refuse(
      "bad_type",
      "bot.remote only belongs on a template whose runtime is remote",
    );
  }

  return {
    name: text(block, "name", "bot", TEMPLATE_LIMITS.NAME),
    title: text(block, "title", "bot", TEMPLATE_LIMITS.TITLE),
    roleDescription: text(
      block,
      "role_description",
      "bot",
      TEMPLATE_LIMITS.ROLE_DESCRIPTION,
    ),
    avatarSeed,
    runtime,
    skills:
      block.skills === undefined || block.skills === null
        ? []
        : strings(block.skills, "bot.skills", TEMPLATE_LIMITS.SKILLS),
    remote: block.remote === undefined ? undefined : parseRemote(block.remote),
  };
}

function parseSkills(value: unknown): BotTemplateSkill[] {
  if (value === undefined || value === null) return [];
  const entries = list(value, "skills");
  if (entries.length > TEMPLATE_LIMITS.SKILLS) {
    refuse(
      "too_many",
      `skills has more than ${TEMPLATE_LIMITS.SKILLS} entries`,
    );
  }

  let refs = 0;
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const where = `skills[${index}]`;
    const block = record(entry, where);
    onlyKnownKeys(block, SKILL_KEYS, where);

    const slug = text(block, "slug", where, TEMPLATE_LIMITS.SLUG);
    if (!SLUG.test(slug)) {
      refuse(
        "bad_slug",
        `${where}.slug "${slug}" must be lowercase letters, digits and hyphens, at least two characters, and must not start or end with a hyphen`,
      );
    }
    if (seen.has(slug)) refuse("bad_slug", `skills defines "${slug}" twice`);
    seen.add(slug);

    const tools =
      block.tools === undefined || block.tools === null
        ? []
        : strings(block.tools, `${where}.tools`, TEMPLATE_LIMITS.TOOL_REFS);
    for (const ref of tools) {
      if (!TOOL_REF.test(ref)) {
        refuse(
          "bad_tool_ref",
          `${where}.tools entry "${ref}" must be written as serverId/toolName`,
        );
      }
    }
    refs += tools.length;
    if (refs > TEMPLATE_LIMITS.TOOL_REFS) {
      refuse(
        "too_many",
        `the template declares more than ${TEMPLATE_LIMITS.TOOL_REFS} tools in total`,
      );
    }

    return {
      slug,
      title: text(block, "title", where, TEMPLATE_LIMITS.SKILL_TITLE),
      summary: text(block, "summary", where, TEMPLATE_LIMITS.SUMMARY),
      instructions: text(
        block,
        "instructions",
        where,
        TEMPLATE_LIMITS.INSTRUCTIONS,
      ),
      tools: [...new Set(tools)],
    };
  });
}

function parseRequests(value: unknown): BotTemplateRequests {
  if (value === undefined || value === null)
    return { connectors: [], components: [] };
  const block = record(value, "requests");
  onlyKnownKeys(block, REQUEST_KEYS, "requests");

  const connectors = (
    block.connectors === undefined || block.connectors === null
      ? []
      : list(block.connectors, "requests.connectors")
  ).map((entry, index) => {
    const where = `requests.connectors[${index}]`;
    const connector = record(entry, where);
    onlyKnownKeys(connector, CONNECTOR_KEYS, where);
    const id = text(connector, "id", where, TEMPLATE_LIMITS.SLUG);

    const tools = (
      connector.tools === undefined || connector.tools === null
        ? []
        : list(connector.tools, `${where}.tools`)
    ).map((toolEntry, toolIndex) => {
      const toolWhere = `${where}.tools[${toolIndex}]`;
      const tool = record(toolEntry, toolWhere);
      onlyKnownKeys(tool, CONNECTOR_TOOL_KEYS, toolWhere);
      const ref = text(tool, "ref", toolWhere, 120);
      if (!TOOL_REF.test(ref)) {
        refuse(
          "bad_tool_ref",
          `${toolWhere}.ref "${ref}" must be written as serverId/toolName`,
        );
      }
      /*
       * The ref has to belong to the connector it is filed under. Otherwise a template could list one
       * harmless-looking connector and hang another's tools off it, and the consent screen — which
       * groups the ask by connector — would render it under the wrong heading, which is the one place
       * a person is reading carefully.
       */
      if (!ref.startsWith(`${id}/`)) {
        refuse(
          "bad_tool_ref",
          `${toolWhere}.ref "${ref}" is filed under connector "${id}" but does not belong to it`,
        );
      }
      return { ref, why: text(tool, "why", toolWhere, TEMPLATE_LIMITS.WHY) };
    });

    return {
      id,
      why: text(connector, "why", where, TEMPLATE_LIMITS.WHY),
      tools,
    };
  });

  const components = (
    block.components === undefined || block.components === null
      ? []
      : list(block.components, "requests.components")
  ).map((entry, index) => {
    const where = `requests.components[${index}]`;
    const component = record(entry, where);
    onlyKnownKeys(component, COMPONENT_KEYS, where);
    return {
      name: text(component, "name", where, 80),
      why: text(component, "why", where, TEMPLATE_LIMITS.WHY),
    };
  });

  const total =
    connectors.length +
    components.length +
    connectors.reduce((sum, connector) => sum + connector.tools.length, 0);
  if (total > TEMPLATE_LIMITS.REQUEST_ENTRIES) {
    refuse(
      "too_many",
      `the template asks for more than ${TEMPLATE_LIMITS.REQUEST_ENTRIES} things`,
    );
  }

  return { connectors, components };
}

function parseBoundary(value: unknown): BotTemplateBoundary {
  if (value === undefined || value === null) return { ...STRICT_BOUNDARY };
  const block = record(value, "boundary");
  onlyKnownKeys(block, BOUNDARY_KEYS, "boundary");

  const hosts =
    block.navigate_hosts === undefined || block.navigate_hosts === null
      ? []
      : strings(
          block.navigate_hosts,
          "boundary.navigate_hosts",
          TEMPLATE_LIMITS.HOSTS,
        );
  for (const host of hosts) {
    if (!HOSTNAME.test(host.toLowerCase())) {
      refuse(
        "bad_hostname",
        `boundary.navigate_hosts entry "${host}" must be a plain hostname: no scheme, no port, no path and no wildcard, because it is compiled to an equality test rather than to a pattern`,
      );
    }
  }

  return {
    shell: choice(
      block,
      "shell",
      "boundary",
      ["never", "permitted"] as const,
      STRICT_BOUNDARY.shell,
    ),
    files: choice(
      block,
      "files",
      "boundary",
      ["none", "read_only", "read_write"] as const,
      STRICT_BOUNDARY.files,
    ),
    browser: choice(
      block,
      "browser",
      "boundary",
      ["none", "read_only", "full"] as const,
      STRICT_BOUNDARY.browser,
    ),
    navigateHosts: [...new Set(hosts.map((host) => host.toLowerCase()))],
    mcp: choice(
      block,
      "mcp",
      "boundary",
      ["none", "read_only", "read_write"] as const,
      STRICT_BOUNDARY.mcp,
    ),
  };
}

/**
 * A YAML document into a template, or a refusal naming what is wrong with it.
 *
 * Every check here runs again at install against this same function, so a preview somebody consented
 * to and the install that follows are answering the same question. Nothing about the deployment is
 * consulted: whether a connector exists, whether a slug is taken and whether an endpoint is reachable
 * are resolution questions, and they belong to the caller that can see the database.
 */
export function parseBotTemplate(source: string): BotTemplate {
  refuseHostileBytes(source);

  let document: unknown;
  try {
    document = parse(source);
  } catch (error) {
    refuse(
      "malformed_yaml",
      `The document is not valid YAML: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  const root = record(document, "the document");
  onlyKnownKeys(root, ROOT_KEYS, "the document");

  const format = root.openbot_template;
  if (format !== BOT_TEMPLATE_FORMAT) {
    refuse(
      "format_version",
      `openbot_template must be ${BOT_TEMPLATE_FORMAT}. This deployment cannot read format ${
        format === undefined ? "(absent)" : JSON.stringify(format)
      }.`,
    );
  }

  const meta = parseMeta(root.template);
  const bot = parseBot(root.bot);
  const skills = parseSkills(root.skills);
  const requests = parseRequests(root.requests);
  const boundary = parseBoundary(root.boundary);
  const notes = optionalText(
    root,
    "notes",
    "the document",
    TEMPLATE_LIMITS.NOTES,
  );

  /*
   * A Bot may only be given skills this same file defines.
   *
   * Refused rather than dropped, which is the judgement `validateTenantPackage` already makes: a slug
   * matching nothing is a typo, and a typo that silently attaches no skill is the kind nobody finds,
   * because the Bot simply never narrows its tools and the deployment looks like it is working.
   *
   * Deliberately not checked against skills already in the importing deployment: those include ones
   * people wrote, and a template must not be able to hand its Bot somebody else's instructions by
   * naming their slug.
   */
  const defined = new Set(skills.map((skill) => skill.slug));
  for (const slug of bot.skills) {
    if (!defined.has(slug)) {
      refuse(
        "unknown_skill",
        `bot.skills names "${slug}", which this template does not define. A template may only give its Bot its own skills.`,
      );
    }
  }

  return {
    format: BOT_TEMPLATE_FORMAT,
    template: meta,
    bot,
    skills,
    requests,
    boundary,
    notes,
  };
}

/** Key-sorted, so a digest depends on what a document says rather than on how it was written. */
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, ordered(entry)]),
    );
  }
  return typeof value === "string" ? value.normalize("NFC") : value;
}

/**
 * What a preview and an install agree they are talking about.
 *
 * Over the PARSED document rather than the source text, so reordering keys, changing quoting style or
 * re-wrapping a folded block does not move it, while changing a single character of anybody's prose
 * does. Strings are NFC-normalised here and at parse, so the digest a reviewer was shown is the
 * digest the install recomputes.
 */
export async function botTemplateDigest(
  template: BotTemplate,
): Promise<string> {
  const canonical = JSON.stringify(ordered(template));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The mark a grant an import made carries, so a retraction takes back exactly what it gave.
 *
 * The same mechanism `tenant-package.ts` uses for its own grants, and for the same reason: every
 * other value in that column is the id of the person who pressed the button, so this cannot collide
 * with one, and a grant an administrator made by hand survives a retraction untouched.
 */
export function templateGrantMark(digest: string): string {
  return `template:${digest.slice(0, 12)}`;
}

/**
 * A template back to the file a person edits.
 *
 * Snake-case on the way out, because the format's vocabulary is the tenant package's and a reader
 * moving between `examples/fintech/agents.yaml` and a template should not have to notice which one
 * they are in. Absent optional keys are omitted rather than written as null: a template is read by
 * people, and a null license is noise that invites somebody to fill it in.
 */
export function serializeBotTemplate(template: BotTemplate): string {
  const meta: Record<string, unknown> = { slug: template.template.slug };
  if (template.template.version) meta.version = template.template.version;
  if (template.template.author) meta.author = template.template.author;
  if (template.template.source) meta.source = template.template.source;
  meta.summary = template.template.summary;
  if (template.template.license) meta.license = template.template.license;

  const bot: Record<string, unknown> = {
    name: template.bot.name,
    title: template.bot.title,
    role_description: template.bot.roleDescription,
  };
  if (template.bot.avatarSeed) bot.avatar_seed = template.bot.avatarSeed;
  bot.runtime = template.bot.runtime;
  if (template.bot.skills.length) bot.skills = template.bot.skills;
  if (template.bot.remote) {
    const remote: Record<string, unknown> = {};
    if (template.bot.remote.authHeader)
      remote.auth_header = template.bot.remote.authHeader;
    remote.requires_key = template.bot.remote.requiresKey;
    if (template.bot.remote.exampleUrl)
      remote.example_url = template.bot.remote.exampleUrl;
    if (template.bot.remote.sendsConversationTo) {
      remote.sends_conversation_to = template.bot.remote.sendsConversationTo;
    }
    bot.remote = remote;
  }

  const document: Record<string, unknown> = {
    openbot_template: template.format,
    template: meta,
    bot,
  };

  if (template.skills.length) {
    document.skills = template.skills.map((skill) => {
      const entry: Record<string, unknown> = {
        slug: skill.slug,
        title: skill.title,
        summary: skill.summary,
        instructions: skill.instructions,
      };
      if (skill.tools.length) entry.tools = skill.tools;
      return entry;
    });
  }

  if (
    template.requests.connectors.length ||
    template.requests.components.length
  ) {
    const requests: Record<string, unknown> = {};
    if (template.requests.connectors.length) {
      requests.connectors = template.requests.connectors.map((connector) => {
        const entry: Record<string, unknown> = {
          id: connector.id,
          why: connector.why,
        };
        if (connector.tools.length) entry.tools = connector.tools;
        return entry;
      });
    }
    if (template.requests.components.length)
      requests.components = template.requests.components;
    document.requests = requests;
  }

  document.boundary = {
    shell: template.boundary.shell,
    files: template.boundary.files,
    browser: template.boundary.browser,
    ...(template.boundary.navigateHosts.length
      ? { navigate_hosts: template.boundary.navigateHosts }
      : {}),
    mcp: template.boundary.mcp,
  };

  if (template.notes) document.notes = template.notes;

  return stringify(document, { lineWidth: 96 });
}
