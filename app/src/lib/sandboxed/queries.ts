import { queryOptions } from "@tanstack/react-query";

/** A component authored in the browser, as the playground edits it. */
export type SandboxedRecord = {
  name: string;
  title: string;
  draftDescription: string;
  draftHtml: string;
  draftCss: string;
  draftJsFunctions: string;
  draftArgumentSchema: Record<string, unknown>;
  publishedHtml: string | null;
  publishedCss: string | null;
  publishedJsFunctions: string | null;
  publishedArgumentSchema: Record<string, unknown> | null;
  sampleArguments: Record<string, unknown>;
  revision: number;
  published: boolean;
  publishedAt: string | null;
  authoredBy: string | null;
  hasUnpublishedChanges: boolean;
};

/** What a Bot may actually draw with. The draft never appears here. */
export type PublishedSandboxed = {
  name: string;
  html: string;
  css: string;
  jsFunctions: string;
  /** What the model fills in. A tool with no parameters is called with no arguments. */
  argumentSchema: Record<string, unknown>;
};

export const sandboxedKeys = {
  all: ["sandboxed"] as const,
  list: () => ["sandboxed", "list"] as const,
  published: () => ["sandboxed", "published"] as const,
};

export function sandboxedListQueryOptions() {
  return queryOptions({
    queryKey: sandboxedKeys.list(),
    queryFn: async (): Promise<SandboxedRecord[]> => {
      const response = await fetch("/api/sandboxed", {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error("The playground's components could not be loaded.");
      }
      return (await response.json()).components ?? [];
    },
  });
}

/**
 * The published source, which is what a conversation renders from.
 *
 * Refetched periodically so publishing takes effect in an open conversation without a reload. It is
 * not what enforces anything: whether this Bot may use the component at all is the grant, which the
 * server is asked about separately and at call time.
 */
export function publishedSandboxedQueryOptions() {
  return queryOptions({
    queryKey: sandboxedKeys.published(),
    refetchInterval: 30_000,
    queryFn: async (): Promise<PublishedSandboxed[]> => {
      const response = await fetch("/api/sandboxed/published", {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error("The published components could not be loaded.");
      }
      return (await response.json()).components ?? [];
    },
  });
}
