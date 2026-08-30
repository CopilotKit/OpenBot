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
   * Why an address is being asked for.
   *
   * `no_managed_agent` is not the remote case: the template says the coworker runs in the box, and
   * this deployment has no box to run it in — the recommended one-container image is exactly that.
   */
  reason: "remote" | "no_managed_agent" | null;
  requiresKey: boolean;
  authHeader?: string;
  exampleUrl?: string;
  sendsConversationTo?: string;
};

/** What this file would do on this deployment. The server writes nothing to produce it. */
export type TemplatePlan = {
  digest: string;
  connectors: ResolvedConnector[];
  components: ResolvedComponent[];
  skills: ResolvedSkill[];
  endpoint: ResolvedEndpoint;
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

export type TemplateBoundaryRecord = {
  importId: string;
  agentId: string;
  expression: string;
  sourceKey: "shell" | "files" | "browser" | "navigate_hosts" | "mcp";
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
