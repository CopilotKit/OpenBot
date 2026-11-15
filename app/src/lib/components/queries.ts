import { queryOptions } from "@tanstack/react-query";
import {
  announceComponents,
  callComponentFunction as callComponentFunctionApi,
  checkBotComponent,
  listBotComponents,
  listComponentFunctions,
  listComponents,
} from "@/lib/api/generated/components/components";
import type { Component } from "@/lib/api/generated/model";
import { everyPage } from "@/lib/api/every-page";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";

/** The kind the API gives a component an admin wrote in Playground. */
export const PLAYGROUND_KIND = "playground";

/** A Playground component's source as an admin edits it. */
export type PlaygroundDraftSource = {
  html: string;
  css: string;
  jsFunctions: string;
  argumentSchema: Record<string, unknown>;
  sampleArguments: Record<string, unknown>;
};

/**
 * A component as the Admin surface sees it: its state, its versions and who is held back from it.
 *
 * Somebody who isn't an admin is sent the published components only, with nothing an admin governs:
 * for them the draft is the published description and the lists are empty.
 */
export type ComponentRecord = {
  name: string;
  title: string;
  /** chart, card and so on, or {@link PLAYGROUND_KIND} for one written in Playground. */
  kind: string;
  draftDescription: string;
  publishedDescription: string | null;
  published: boolean;
  publishedAt: string | null;
  updatedBy: string | null;
  updatedAt: string;
  hasUnpublishedChanges: boolean;
  /** The Bots held back from this. Every other Bot may answer with it. */
  withheldFrom: string[];
  /** The data functions this component may read. Empty means it draws only what the model hands it. */
  functions: string[];
  /** A Playground component's draft source, for an admin. Null otherwise. */
  draftSource: PlaygroundDraftSource | null;
  /** A published Playground component's source, which a conversation draws it from. Null otherwise. */
  source: {
    html: string;
    css: string;
    jsFunctions: string;
    argumentSchema: Record<string, unknown>;
    revision: number;
  } | null;
};

/** A component as a Bot holds it: the name to register, and what the model is told about it. */
export type GrantedComponent = {
  name: string;
  description: string;
};

/** A component written in Playground, as the playground edits it. */
export type PlaygroundRecord = {
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
  hasUnpublishedChanges: boolean;
};

/** What a Bot may actually draw with. The draft never appears here. */
export type PublishedPlayground = {
  name: string;
  html: string;
  css: string;
  jsFunctions: string;
  /** What the model fills in. A tool with no parameters is called with no arguments. */
  argumentSchema: Record<string, unknown>;
};

export const componentKeys = {
  all: ["components"] as const,
  list: () => ["components", "list"] as const,
  forAgent: (agentId: string) => ["components", "for-agent", agentId] as const,
  functions: (name: string) => ["components", "functions", name] as const,
  playground: () => ["components", "playground"] as const,
  published: () => ["components", "playground", "published"] as const,
};

/** One component in the shape the screens read. */
function componentRecord(component: Component): ComponentRecord {
  return {
    name: component.name,
    title: component.title,
    kind: component.kind,
    draftDescription:
      component.draft?.description ?? component.description ?? "",
    publishedDescription: component.description,
    published: component.published,
    publishedAt: component.publishedAt,
    updatedBy: component.updatedBy,
    updatedAt: component.updatedAt,
    hasUnpublishedChanges: component.hasUnpublishedChanges ?? false,
    withheldFrom: component.withheldFrom ?? [],
    functions: component.functions ?? [],
    draftSource: component.draft?.source ?? null,
    source: component.source,
  };
}

/** Every component the caller may see, every page read, optionally of one kind. */
async function everyComponent(kind?: string): Promise<Component[]> {
  return everyPage(async (cursor) => {
    const page = await listComponents(
      organizationId(),
      {
        limit: 100,
        ...(kind === undefined ? {} : { kind }),
        ...(cursor === undefined ? {} : { cursor }),
      },
      { fallback: "The components could not be loaded." },
    );
    return { items: page.components, nextCursor: page.nextCursor };
  });
}

export function componentListQueryOptions() {
  return queryOptions({
    queryKey: componentKeys.list(),
    queryFn: async (): Promise<ComponentRecord[]> =>
      (await everyComponent()).map(componentRecord),
  });
}

/**
 * What one Bot may answer with.
 *
 * Polled so open conversations stop offering revoked components; call-time checks still enforce
 * the grant.
 */
export function agentComponentsQueryOptions(agentId: string | undefined) {
  return queryOptions({
    queryKey: componentKeys.forAgent(agentId ?? ""),
    enabled: Boolean(agentId),
    refetchInterval: 5_000,
    // Refetched when the tab is looked at again, so a grant changed on another screen is not waiting
    // out an interval before it shows.
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<GrantedComponent[]> =>
      everyPage(async (cursor) => {
        const page = await listBotComponents(
          organizationId(),
          agentId ?? "",
          { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
          { fallback: "This Bot's components could not be loaded." },
        );
        return { items: page.components, nextCursor: page.nextCursor };
      }),
  });
}

/** Announce the compiled gallery catalogue to the server; additive failures do not block UI use. */
export async function announceGallery(
  components: {
    name: string;
    title: string;
    kind: string;
    description: string;
  }[],
): Promise<string[]> {
  try {
    const { added } = await announceComponents(
      organizationId(),
      { components },
      { "Idempotency-Key": idempotencyKey() },
    );
    return added;
  } catch {
    return [];
  }
}

/** A data function this build ships, as an administrator sees it for one component. */
export type DataFunctionSummary = {
  name: string;
  description: string;
  reads: string;
  /** Whether this component may read it. */
  granted: boolean;
};

/** The data functions this build ships, each with whether this component may read it. */
export function componentFunctionsQueryOptions(name: string) {
  return queryOptions({
    queryKey: componentKeys.functions(name),
    queryFn: async (): Promise<DataFunctionSummary[]> =>
      everyPage(async (cursor) => {
        const page = await listComponentFunctions(
          organizationId(),
          name,
          { limit: 100, ...(cursor === undefined ? {} : { cursor }) },
          { fallback: "The data functions could not be loaded." },
        );
        return { items: page.functions, nextCursor: page.nextCursor };
      }),
  });
}

/** Every component written in Playground, with its draft, as an admin edits them. */
export function playgroundListQueryOptions() {
  return queryOptions({
    queryKey: componentKeys.playground(),
    queryFn: async (): Promise<PlaygroundRecord[]> =>
      (await everyComponent(PLAYGROUND_KIND)).map((component) => {
        const draft = component.draft?.source;
        return {
          name: component.name,
          title: component.title,
          draftDescription: component.draft?.description ?? "",
          draftHtml: draft?.html ?? "",
          draftCss: draft?.css ?? "",
          draftJsFunctions: draft?.jsFunctions ?? "",
          draftArgumentSchema: draft?.argumentSchema ?? {},
          publishedHtml: component.source?.html ?? null,
          publishedCss: component.source?.css ?? null,
          publishedJsFunctions: component.source?.jsFunctions ?? null,
          publishedArgumentSchema: component.source?.argumentSchema ?? null,
          sampleArguments: draft?.sampleArguments ?? {},
          revision: component.source?.revision ?? 0,
          published: component.published,
          publishedAt: component.publishedAt,
          hasUnpublishedChanges: component.hasUnpublishedChanges ?? false,
        };
      }),
  });
}

/**
 * The published source, which is what a conversation renders from.
 *
 * Refetched periodically so publishing takes effect in an open conversation without a reload. It is
 * not what enforces anything: whether this Bot may use the component at all is the grant, which the
 * server is asked about separately and at call time.
 */
export function publishedPlaygroundQueryOptions() {
  return queryOptions({
    queryKey: componentKeys.published(),
    refetchInterval: 30_000,
    queryFn: async (): Promise<PublishedPlayground[]> =>
      (await everyComponent(PLAYGROUND_KIND)).flatMap((component) =>
        component.source
          ? [
              {
                name: component.name,
                html: component.source.html,
                css: component.source.css,
                jsFunctions: component.source.jsFunctions,
                argumentSchema: component.source.argumentSchema,
              },
            ]
          : [],
      ),
  });
}

/**
 * A component reading real data for itself.
 *
 * Data is fetched from the deployment after the server checks this component's data-function grant.
 * Failure to check the grant fails closed.
 */
export async function callComponentFunction(
  component: string,
  functionName: string,
  args: Record<string, unknown>,
  agentId: string,
): Promise<{
  allowed: boolean;
  data?: unknown;
  reason?: string;
}> {
  try {
    const result = await callComponentFunctionApi(
      organizationId(),
      agentId,
      component,
      { function: functionName, arguments: args },
      { "Idempotency-Key": idempotencyKey() },
    );
    return result.allowed
      ? { allowed: true, data: result.data }
      : { allowed: false, reason: result.reason ?? undefined };
  } catch (error) {
    return {
      allowed: false,
      reason:
        error instanceof ClientError
          ? error.message
          : "OpenBot couldn't be reached to read that data.",
    };
  }
}

/**
 * Ask the server whether this Bot may use this component right now; failures fail closed.
 *
 * `functions` are the data functions the component will read with these arguments. Naming them here
 * makes the verdict cover what the component will do rather than only its name.
 */
export async function decideComponent(
  name: string,
  agentId: string,
  functions: readonly string[] = [],
): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const decision = await checkBotComponent(
      organizationId(),
      agentId,
      name,
      { functions: [...functions] },
      { "Idempotency-Key": idempotencyKey() },
    );
    return decision.allowed
      ? { allowed: true }
      : { allowed: false, reason: decision.reason ?? undefined };
  } catch (error) {
    return {
      allowed: false,
      reason:
        error instanceof ClientError
          ? "OpenBot couldn't be asked whether that component is allowed, so it wasn't shown."
          : "OpenBot couldn't be reached to check whether that component is allowed, so it wasn't shown.",
    };
  }
}
