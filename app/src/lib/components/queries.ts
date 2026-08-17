import { queryOptions } from "@tanstack/react-query";

/** A component as the Admin surface sees it: its state, its versions and who is held back from it. */
export type ComponentRecord = {
  name: string;
  title: string;
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
};

/** A component as a Bot holds it: the name to register, and what the model is told about it. */
export type GrantedComponent = {
  name: string;
  description: string;
};

export const componentKeys = {
  all: ["components"] as const,
  list: () => ["components", "list"] as const,
  forAgent: (agentId: string) => ["components", "for-agent", agentId] as const,
};

export function componentListQueryOptions() {
  return queryOptions({
    queryKey: componentKeys.list(),
    queryFn: async (): Promise<ComponentRecord[]> => {
      const response = await fetch("/api/components", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("The components could not be loaded.");
      return (await response.json()).components ?? [];
    },
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
    queryFn: async (): Promise<GrantedComponent[]> => {
      const response = await fetch(
        `/api/components/for-agent/${encodeURIComponent(agentId ?? "")}`,
        { credentials: "include" },
      );
      if (!response.ok) {
        throw new Error("This Bot's components could not be loaded.");
      }
      return (await response.json()).components ?? [];
    },
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
    const response = await fetch("/api/components/catalogue", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ components }),
    });
    if (!response.ok) return [];
    return (await response.json()).added ?? [];
  } catch {
    return [];
  }
}

/** A data function this build ships, as an administrator sees it. */
export type DataFunctionSummary = {
  name: string;
  description: string;
  reads: string;
};

export function dataFunctionsQueryOptions() {
  return queryOptions({
    queryKey: ["components", "functions"] as const,
    queryFn: async (): Promise<DataFunctionSummary[]> => {
      const response = await fetch("/api/components/functions", {
        credentials: "include",
      });
      if (!response.ok)
        throw new Error("The data functions could not be loaded.");
      return (await response.json()).functions ?? [];
    },
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
  error?: string;
}> {
  try {
    const response = await fetch(
      `/api/components/${encodeURIComponent(component)}/call`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, args, function: functionName }),
      },
    );
    const payload = await response.json().catch(() => null);
    if (payload && typeof payload === "object") {
      return payload as { allowed: boolean; data?: unknown; reason?: string };
    }
    return {
      allowed: false,
      reason: "This deployment could not be asked for that data.",
    };
  } catch {
    return {
      allowed: false,
      reason: "This deployment could not be reached to read that data.",
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
    const response = await fetch(
      `/api/components/${encodeURIComponent(name)}/decision`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, functions }),
      },
    );
    if (!response.ok) {
      return {
        allowed: false,
        reason:
          "This deployment could not be asked whether that component is allowed, so it was not shown.",
      };
    }
    return await response.json();
  } catch {
    return {
      allowed: false,
      reason:
        "This deployment could not be reached to check whether that component is allowed, so it was not shown.",
    };
  }
}
