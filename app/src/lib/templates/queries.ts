import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

/**
 * A Bot template as the browser sees it, and why these types are restated rather than imported.
 *
 * The format lives in `shared/bot-template.ts`, which is where the refusals are and where the only
 * copy that decides anything is. It cannot be imported here for two reasons that both matter: the
 * app's `tsconfig.json` includes `src` and exactly one file out of `shared/`, and that module
 * imports the `yaml` package — a server dependency the app does not have — so reaching for it to
 * borrow a type would pull a YAML parser into the browser bundle and put a second parser in front
 * of a stranger's file.
 *
 * So these are the shapes the server *sends*, and nothing here parses, validates or decides. The
 * browser never re-derives a refusal: what it renders is what the server already accepted. If a
 * field is added to the format, the consent screen shows nothing for it until it is added here,
 * which is the safe direction — a field the screen cannot render is a field nobody consented to,
 * and it is better for it to be absent than to be rendered by a guess.
 */
export type TemplateRuntime = "managed" | "remote";
export type TemplateShell = "never" | "permitted";
export type TemplateFiles = "none" | "read_only" | "read_write";
export type TemplateBrowser = "none" | "read_only" | "full";
export type TemplateMcp = "none" | "read_only" | "read_write";

export type BotTemplateRemote = {
  /** The header NAME. The value never travels; the importer types it into their own vault. */
  authHeader?: string;
  requiresKey: boolean;
  /** Documentation the author wrote. Never dialled, and rendered as plain text, never as a link. */
  exampleUrl?: string;
  /** Where the author SAYS conversations go. A claim, compared with what the importer typed. */
  sendsConversationTo?: string;
};

export type BotTemplateBot = {
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed?: string;
  runtime: TemplateRuntime;
  skills: string[];
  remote?: BotTemplateRemote;
};

export type BotTemplateSkill = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  /** `<serverId>/<toolName>` declarations. Not grants, and checked against nothing. */
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
  navigateHosts: string[];
  mcp: TemplateMcp;
};

export type BotTemplateMeta = {
  slug: string;
  version?: string;
  /** A CLAIM, never verified. Rendered as one, and never used to decide anything. */
  author?: string;
  /** Attacker-controlled text. Rendered as plain text; never as an anchor. */
  source?: string;
  summary: string;
  license?: string;
};

export type BotTemplate = {
  format: number;
  template: BotTemplateMeta;
  bot: BotTemplateBot;
  skills: BotTemplateSkill[];
  requests: BotTemplateRequests;
  boundary: BotTemplateBoundary;
  notes?: string;
};

/** How a skill slug already taken on this deployment will be resolved. Never overwrite. */
export type SlugResolution = "reuse" | "suffix" | "skip";

export type ResolvedTool = {
  ref: string;
  why: string;
  verdict: "available" | "unavailable";
};

export type ResolvedConnector = {
  id: string;
  why: string;
  verdict: "available" | "unavailable";
  tools: ResolvedTool[];
};

export type ResolvedComponent = {
  name: string;
  why: string;
  verdict: "available" | "not_in_build";
  published: boolean;
};

export type ResolvedSkill = {
  slug: string;
  title: string;
  collides: boolean;
  /** Whether the skill already here is byte-identical, which is what makes reuse offerable. */
  identical: boolean;
  resolution: SlugResolution;
  installAs: string | null;
  suffixCandidate: string | null;
  paired: boolean;
};

export type ResolvedEndpoint = {
  required: boolean;
  /**
   * Why an address is being asked for, and there is only one reason left.
   *
   * `no_managed_agent` used to be the other one: a template that said the coworker runs here, on a
   * deployment with no managed Bot to run it, was answered by asking the importer for an address.
   * That made somebody register a third-party endpoint in order to try a template, and their
   * conversations then left the network — the opposite of what the file said. A template that says
   * it runs here now runs in this deployment's own process, so the only coworker that still needs
   * an address is the one whose file says it runs at one.
   */
  reason: "remote" | null;
  requiresKey: boolean;
  authHeader?: string;
  exampleUrl?: string;
  sendsConversationTo?: string;
};

/**
 * Where the coworker will actually run, which is a different question from what the file asked for.
 *
 * `runtime: managed` is the author saying "run this yourself", and a deployment can honour that two
 * ways: on the managed Bot it runs, or in this process on its own model. Which of the two is a fact
 * about the deployment rather than about the file, so the plan answers it and the consent screen
 * says it — a screen that read `bot.runtime` could only say what was asked for. `address` is the one
 * case where the importer has to supply something before the coworker can exist at all.
 */
export type TemplateRuntimeHome = "managed_agent" | "in_process" | "address";

/** What this file would do on this deployment. The server writes nothing to produce it. */
export type TemplatePlan = {
  digest: string;
  connectors: ResolvedConnector[];
  components: ResolvedComponent[];
  skills: ResolvedSkill[];
  endpoint: ResolvedEndpoint;
  runsOn: TemplateRuntimeHome;
  slugDecisions: Record<string, SlugResolution>;
};

/** A draft this deployment authored. The document is not in it; `/file` is how one is read. */
export type TemplateDraftSummary = {
  id: string;
  agentId: string | null;
  slug: string;
  name: string;
  title: string;
  summary: string;
  skills: string[];
  createdAt: string;
  updatedAt: string;
  /** Whether the signed-in person authored it. An administrator sees the deployment's. */
  mine: boolean;
};

export type TemplateRequestKind = "mcp" | "component" | "endpoint";
export type TemplateRequestStatus =
  | "requested"
  | "unavailable"
  | "not_in_build"
  | "granted"
  | "declined";

/**
 * One line of the consent ledger: what a template asked for, and what has been decided since.
 *
 * `status` records that a person decided, never that a grant is in force. Whether a capability
 * exists is answered live by the grant tables, which is why there is no `satisfied` field.
 */
export type TemplateRequestRecord = {
  importId: string;
  kind: TemplateRequestKind;
  ref: string;
  /** The author's sentence. A stranger's prose, rendered verbatim and never as markup. */
  why: string;
  status: TemplateRequestStatus;
  decidedBy: string | null;
  decidedAt: string | null;
};

/** Which line of the `boundary:` vocabulary a clause was compiled from. */
export type TemplateBoundarySourceKey =
  | "shell"
  | "files"
  | "browser"
  | "navigate_hosts"
  | "mcp";

export type TemplateBoundaryRecord = {
  importId: string;
  agentId: string;
  expression: string;
  sourceKey: TemplateBoundarySourceKey;
  appliedAt: string;
  removedAt: string | null;
};

/** Where an imported Bot came from, exactly as it was consented to. */
export type TemplateImportRow = {
  id: string;
  agentId: string;
  digest: string;
  slug: string;
  templateVersion: string | null;
  /** A CLAIM the author wrote. The column name says what it is. */
  authorClaim: string | null;
  source: "paste" | "file" | "gallery";
  sourceRef: string | null;
  document: BotTemplate;
  importedBy: string;
  importedAt: string;
};

export type TemplateImportRecord = {
  import: TemplateImportRow;
  requests: TemplateRequestRecord[];
  boundaries: TemplateBoundaryRecord[];
};

export const templateKeys = {
  all: ["templates"] as const,
  drafts: () => ["templates", "drafts"] as const,
  draftSource: (templateId: string) =>
    ["templates", "draft-source", templateId] as const,
  import: (agentId: string) => ["templates", "import", agentId] as const,
  boundaries: () => ["templates", "boundaries"] as const,
};

export function templateDraftListQueryOptions() {
  return queryOptions({
    queryKey: templateKeys.drafts(),
    queryFn: (): Promise<TemplateDraftSummary[]> =>
      client("/api/templates", "templates", {
        fallback: "Could not load your template drafts",
      }),
  });
}

/**
 * One draft as the file it is.
 *
 * The body is YAML rather than JSON, so this reads the response rather than unwrapping an envelope.
 * It is the same route the Download button serves, which is deliberate: what a person edits, reads
 * and sends is one artifact, not three renderings of one.
 */
export function templateDraftSourceQueryOptions(templateId: string) {
  return queryOptions({
    queryKey: templateKeys.draftSource(templateId),
    queryFn: async (): Promise<string> => {
      const response = await client(`/api/templates/${templateId}/file`, {
        fallback: "Could not load this template draft",
      });
      return response.text();
    },
  });
}

/**
 * Where a Bot came from, or nothing.
 *
 * A 404 is the ordinary answer here — most Bots were made by hand — so this fails closed to `null`
 * rather than throwing. `tryClient` for the same reason `currentUserQueryOptions` uses it: the
 * status is the answer, and turning "this Bot was not imported" into an error would put a red
 * sentence on every hand-made coworker's profile.
 *
 * The route answers 404 for a Bot the caller may not see as well, matching
 * `GET /api/plugins/for/:agentId` — a distinguishable "you may not" would be an oracle for other
 * people's private Bots. Both cases arrive here as `null`, which is what the screen needs.
 */
export function templateImportQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: templateKeys.import(agentId),
    queryFn: async (): Promise<TemplateImportRecord | null> => {
      const response = await tryClient(`/api/templates/imports/${agentId}`);
      if (!response.ok) return null;
      return (await response.json()) as TemplateImportRecord;
    },
  });
}

/**
 * One clause an import applied, with the Bot it is about named rather than only identified.
 *
 * `agentName` is on the row because the screen that reads this groups by it, and a screen that had
 * to resolve a name per clause would either issue a request per Bot or show an id where a person
 * expects a coworker. The server already holds both sides of that join.
 *
 * There is no `removedAt`: a retracted clause is not a ceiling, and a list of things that used to
 * be enforced sitting under a heading about what is enforced is the kind of thing an administrator
 * reads once and mistrusts afterwards. What a retraction did is in Audit, which is where a history
 * belongs.
 */
export type AppliedBoundaryClause = {
  importId: string;
  agentId: string;
  agentName: string;
  expression: string;
  sourceKey: TemplateBoundarySourceKey;
  appliedAt: string;
};

/**
 * Every clause an import applied and has not retracted, across the deployment.
 *
 * Deliberately separate from `actionPolicyQueryOptions`, which reads `action_policy` — the single
 * row an administrator writes. These clauses live in `template_boundaries` and are composed into
 * the evaluation only, precisely so that the administrator's ordinary save cannot erase them. Two
 * stores, two reads: fetching them through one options factory would invite the screen to render
 * them in one editable list, which is the mistake the separate storage exists to make impossible.
 */
export function appliedBoundaryListQueryOptions() {
  return queryOptions({
    queryKey: templateKeys.boundaries(),
    queryFn: (): Promise<AppliedBoundaryClause[]> =>
      client("/api/templates/boundaries", "boundaries", {
        fallback: "The clauses applied by imports could not be read.",
      }),
  });
}

/**
 * What a refused document was refused for.
 *
 * The machine-readable half, so the screen can say which of two very different things happened —
 * a file that is malformed, and a file that is fine but is no longer the one that was read. The
 * sentence beside it is the server's, which is the one written for a person.
 */
export type TemplatePreviewVerdict =
  | { ok: true; template: BotTemplate; digest: string; plan: TemplatePlan }
  | { ok: false; error: string; reason?: string; field?: string };

/**
 * Read a template without agreeing to anything.
 *
 * A plain function rather than a query factory: the answer is about this text at this moment,
 * nothing caches it and there is no key for anything to invalidate. It fails closed — a refusal is
 * the answer here rather than an exception, because most refusals are the product working, and the
 * consent screen has to render the reason rather than catch it.
 *
 * The server writes nothing on success. It does record a refusal, which is why this is not a thing
 * to call on every keystroke.
 */
export async function previewBotTemplate(
  source: string,
): Promise<TemplatePreviewVerdict> {
  try {
    const response = await tryClient("/api/templates/preview", {
      method: "POST",
      body: { source },
    });
    const body = (await response.json().catch(() => null)) as
      | { template: BotTemplate; digest: string; plan: TemplatePlan }
      | { error?: string; reason?: string; field?: string }
      | null;
    if (response.ok && body && "template" in body) {
      return { ok: true, ...body };
    }
    const refusal = body as {
      error?: string;
      reason?: string;
      field?: string;
    } | null;
    return {
      ok: false,
      error: refusal?.error ?? "This file could not be read as a template.",
      ...(refusal?.reason ? { reason: refusal.reason } : {}),
      ...(refusal?.field ? { field: refusal.field } : {}),
    };
  } catch {
    return { ok: false, error: "This file could not be read as a template." };
  }
}

/**
 * A gallery card: enough to decide whether to open a template, and deliberately not enough to
 * decide whether to run one.
 *
 * There is no `roleDescription` and no skill `instructions` on this type, and their absence is the
 * point rather than an omission. A card is a roster entry; the consent screen is where a stranger's
 * prose is rendered verbatim under a heading saying whose words it is. Putting a paragraph an
 * author wrote onto a screen with no such heading is the exact failure the consent flow exists to
 * prevent, so the server does not send it and this type could not hold it.
 *
 * `author` and `source` are CLAIMS. Nothing verified either, nothing decides anything from either,
 * and both are rendered as plain text — never as an anchor, because a string that looks like an
 * address sitting beside a Bot's name is a thing somebody clicks before they have finished reading.
 */
export type GalleryTemplateCard = {
  slug: string;
  digest: string;
  name: string;
  title: string;
  summary: string;
  /** The drawing the imported coworker will have. An opaque style token, never an id. */
  avatarSeed: string;
  author: string | null;
  version: string | null;
  license: string | null;
  source: string | null;
  /**
   * Which of the nine categories the file put itself in, as the SLUG. Optional: absent means the
   * author did not say, and the gallery calls that uncategorised.
   *
   * The one field on this card an author supplies that is not free text. The vocabulary is closed
   * and the server refuses anything outside it, which is why the gallery can group and count by it
   * without a stranger being able to invent a group, put prose in a chip, or name itself something
   * that sorts to the front. The words drawn for it are this app's, in `lib/templates/categories`;
   * a label that travelled would be a second string somebody else controls.
   */
  category?: string;
  runtime: TemplateRuntime;
  /** The connector ids it ASKS for. Inert: an ask lands on a ledger, never on a grant table. */
  connectors: string[];
  components: string[];
  skills: string[];
  origin: GalleryOrigin;
};

/** Where a gallery entry came from: the image this deployment runs, or a repository somebody pinned. */
export type GalleryOrigin =
  | { kind: "directory"; filename: string }
  | { kind: "source"; sourceId: string; sha: string; path: string };

/**
 * What a file the gallery could not offer was, and why.
 *
 * Rendered rather than swallowed. A gallery that quietly lists three of four templates teaches an
 * operator that the feature is unreliable; one that says which file it skipped and what was wrong
 * with it teaches them that one file is wrong, which is a thing somebody can fix.
 */
export type GallerySkip = { where: string; reason: string; message: string };

export type GalleryListing = {
  templates: GalleryTemplateCard[];
  skipped: GallerySkip[];
  /**
   * Who may install here, so the screen knows whether to offer the button.
   *
   * It travels with the list rather than being fetched beside it: a screen that drew the button and
   * learned the answer from a 403 would have taught somebody to press it first.
   */
  installers: TemplateInstallers;
};

/** One gallery template in both renderings: the document the screen shows, and the file it is. */
export type GalleryTemplate = {
  entry: GalleryTemplateCard;
  template: BotTemplate;
  digest: string;
  /**
   * The YAML, serialised on the server out of the document it parsed.
   *
   * What goes in the consent screen's paste box, so what somebody reads before agreeing is a file
   * they could have been handed by any other means rather than a form this screen assembled.
   */
  yaml: string;
};

/** Who may turn a template into a coworker on this deployment. */
export type TemplateInstallers = "anyone" | "admin";

/** A repository the gallery is allowed to read from, pinned to one commit. */
export type TemplateSourceRecord = {
  id: string;
  owner: string;
  repo: string;
  sha: string;
  registeredBy: string;
  registeredAt: string;
};

/**
 * The deployment's template settings, all four facts together.
 *
 * `floor` is what `OPENBOT_TEMPLATE_INSTALLERS` set and the screen cannot go below — the
 * `INITIAL_ADMIN_EMAILS` pattern, where an environment decision is rendered rather than editable.
 * `allowedSources` is the same shape of fact for repositories. Both are here because `installers`
 * alone cannot tell an administrator why a control is disabled.
 */
export type TemplateSettings = {
  installers: TemplateInstallers;
  floor: TemplateInstallers;
  allowedSources: string[];
  sources: TemplateSourceRecord[];
  /** False on a deployment built without a catalogue, where there is nothing to configure. */
  configured: boolean;
};

/** One imported Bot as the deployment's own roster shows it, with what it asked for and its ceiling. */
export type TemplateImportSummary = {
  id: string;
  agentId: string;
  /** The coworker's name, joined server-side: a screen showing an id where a name belongs is a bug. */
  agentName: string;
  digest: string;
  slug: string;
  templateVersion: string | null;
  /** A CLAIM the author wrote. The field name says what it is, and so does the screen. */
  authorClaim: string | null;
  source: "paste" | "file" | "gallery";
  sourceRef: string | null;
  importedBy: string;
  importedAt: string;
  requests: TemplateRequestRecord[];
  boundaries: TemplateBoundaryRecord[];
};

export const galleryKeys = {
  all: ["template-gallery"] as const,
  list: () => ["template-gallery", "list"] as const,
  detail: (slug: string) => ["template-gallery", "detail", slug] as const,
  settings: () => ["template-gallery", "settings"] as const,
  imports: () => ["template-gallery", "imports"] as const,
};

/** Everything on offer here, in the box and from any source an administrator pinned. */
export function galleryListQueryOptions() {
  return queryOptions({
    queryKey: galleryKeys.list(),
    queryFn: async (): Promise<GalleryListing> => {
      const response = await client("/api/templates/gallery", {
        fallback: "Could not load the template gallery",
      });
      return (await response.json()) as GalleryListing;
    },
  });
}

/** One gallery template, read only when somebody opens it. */
export function galleryTemplateQueryOptions(slug: string) {
  return queryOptions({
    queryKey: galleryKeys.detail(slug),
    queryFn: async (): Promise<GalleryTemplate> => {
      const response = await client(`/api/templates/gallery/${slug}`, {
        fallback: "Could not open that template",
      });
      return (await response.json()) as GalleryTemplate;
    },
  });
}

/** Who may install, the floor under that, and the repositories the gallery may read. */
export function templateSettingsQueryOptions() {
  return queryOptions({
    queryKey: galleryKeys.settings(),
    queryFn: async (): Promise<TemplateSettings> => {
      const response = await client("/api/admin/templates/settings", {
        fallback: "Could not load the template settings",
      });
      return (await response.json()) as TemplateSettings;
    },
  });
}

/** Every Bot in this deployment that arrived as somebody's file. Administrators only. */
export function templateImportListQueryOptions() {
  return queryOptions({
    queryKey: galleryKeys.imports(),
    queryFn: (): Promise<TemplateImportSummary[]> =>
      client("/api/admin/templates/imports", "imports", {
        fallback: "Could not load what this deployment has imported",
      }),
  });
}
