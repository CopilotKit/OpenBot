import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { agentKeys } from "@/lib/agents/queries";
import { client } from "@/lib/client";
import { componentKeys } from "@/lib/components/queries";
import { pluginKeys } from "@/lib/plugins/queries";
import {
  type SlugResolution,
  type TemplatePlan,
  type TemplateRequestKind,
  type TemplateRequestRecord,
  templateKeys,
} from "./queries";

/** The sentence for every write here, since they all fail the same way to a reader. */
const FALLBACK = "Template operation failed";

/** Server-derived fields are invalidated instead of patched by hand. */
function invalidateTemplates(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: templateKeys.all });
}

/** What packing a coworker produced, and what it had to leave behind. */
export type ExportedTemplate = {
  templateId: string;
  yaml: string;
  digest: string;
  /**
   * Every field that did not travel, as sentences.
   *
   * The interesting half of an export. A person about to hand this file to somebody needs to know
   * that the endpoint, the key and the callback token are not in it — and that a package Bot's
   * behaviour is not either.
   */
  stripped: string[];
};

/**
 * Pack a coworker into a draft.
 *
 * A draft rather than a download, because the packer cannot know which of a Bot's grants were
 * requirements and which were an afternoon's experiment, and because `boundary:` is written out at
 * its strictest so the author widens what the coworker actually needs. Both of those are edits, and
 * an edit needs something to edit.
 */
export function exportAgentTemplateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<ExportedTemplate> =>
      client(`/api/agents/${agentId}/template`, {
        method: "POST",
        fallback: FALLBACK,
      }).then((response) => response.json() as Promise<ExportedTemplate>),
    onSuccess: () => invalidateTemplates(queryClient),
  });
}

/**
 * Edit a draft, which is editing a file.
 *
 * The server re-runs the parser and the secret scanner, so this is also how an author finds out
 * that the sentence they just typed looks like a key. A refusal arrives as a thrown `Error`
 * carrying the server's own sentence, which is the one written for a person.
 */
export function updateTemplateDraftMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      templateId: string;
      source: string;
    }): Promise<{ yaml: string; digest: string }> =>
      client(`/api/templates/${variables.templateId}`, {
        method: "PATCH",
        body: { source: variables.source },
        fallback: FALLBACK,
      }).then(
        (response) =>
          response.json() as Promise<{ yaml: string; digest: string }>,
      ),
    onSuccess: () => invalidateTemplates(queryClient),
  });
}

export function deleteTemplateDraftMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (templateId: string) => {
      await client(`/api/templates/${templateId}`, {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateTemplates(queryClient),
  });
}

/**
 * What the importer agreed to, sent back with the digest they were shown.
 *
 * `source` is sent again rather than a draft id, and the digest with it: the server re-parses,
 * re-runs every refusal and recomputes the digest, and answers 409 if it moved. That closes the
 * window between reading a stranger's file and clicking the button — the file on disk, or the
 * gallery entry behind it, can change in between, and what installs must be what was read.
 */
export type TemplateInstallInput = {
  source: string;
  digest: string;
  from?: "paste" | "file" | "gallery";
  sourceRef?: string;
  /** Typed by the importer. A template has no field that could carry an address. */
  endpoint?: string;
  /** Write-only. The header name travelled; the value never did. */
  auth?: { header: string; value: string };
  slugDecisions?: Record<string, SlugResolution>;
};

export type TemplateInstallResult = {
  agentId: string;
  importId: string;
  slug: string;
  digest: string;
  requests: TemplateRequestRecord[];
  plan: TemplatePlan;
  skillsCreated: string[];
  skillsReused: string[];
  skillsSuffixed: string[];
  skillsSkipped: string[];
};

/**
 * The one button.
 *
 * It creates a Bot and its skills, so the roster, the skills a Bot may reach and this Bot's
 * provenance all move at once. Nothing else does: no MCP grant, no component, no policy rule.
 */
export function installBotTemplateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: TemplateInstallInput): Promise<TemplateInstallResult> =>
      client("/api/templates/install", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }).then((response) => response.json() as Promise<TemplateInstallResult>),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: agentKeys.all }),
        queryClient.invalidateQueries({ queryKey: pluginKeys.all }),
        invalidateTemplates(queryClient),
      ]);
    },
  });
}

/**
 * An administrator answering one ask.
 *
 * The grant itself is made by the store that already refuses — this route acts on the ledger row
 * and delegates, so approving a template's request and granting a tool by hand are the same write
 * with the same audit row behind them. Which is why the components and plugins caches are
 * invalidated here as well as the ledger: the thing that changed is a permission, not a note.
 */
export function decideTemplateRequestMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      kind: TemplateRequestKind;
      ref: string;
      verdict: "grant" | "decline";
    }): Promise<TemplateRequestRecord> =>
      client(
        `/api/templates/imports/${variables.agentId}/requests/${variables.kind}/${encodeURIComponent(variables.ref)}/${variables.verdict}`,
        "request",
        { method: "POST", fallback: FALLBACK },
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: pluginKeys.all }),
        queryClient.invalidateQueries({ queryKey: componentKeys.all }),
        invalidateTemplates(queryClient),
      ]);
    },
  });
}

/** What a retraction took back. Never the Bot, and never a skill. */
export type TemplateRetraction = {
  agentId: string;
  importId: string;
  revoked: { kind: string; ref: string }[];
  boundaries: string[];
};

/**
 * Take back what the import gave, and nothing else.
 *
 * Only rows carrying this import's sentinel, so a grant somebody made by hand on the same Bot
 * survives. The Bot, its skills and its provenance row all stand: this is not a delete.
 */
export function retractTemplateImportMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<TemplateRetraction> =>
      client(`/api/templates/imports/${agentId}`, {
        method: "DELETE",
        fallback: FALLBACK,
      }).then((response) => response.json() as Promise<TemplateRetraction>),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: pluginKeys.all }),
        invalidateTemplates(queryClient),
      ]);
    },
  });
}
