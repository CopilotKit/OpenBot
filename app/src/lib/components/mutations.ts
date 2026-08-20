import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { componentKeys } from "./queries";

/**
 * Writes against a component's governance: publication, per-Bot grants, per-function grants, and the
 * draft description.
 *
 * Every one of these is a decision the server records and may refuse, so none of them patch the
 * cache — the list is invalidated and the screen re-reads whatever was actually decided.
 */
async function componentRequest(
  path: string,
  init: { method: string; body?: unknown },
): Promise<Response> {
  const response = await fetch(path, {
    method: init.method,
    credentials: "include",
    headers: init.body ? { "content-type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    // The server's message is the useful one: it names the field or the permission that failed.
    const message = await response
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => undefined);
    throw new Error(message ?? "Component operation failed");
  }
  return response;
}

/** Server-derived fields are invalidated instead of patched by hand. */
function invalidateComponents(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: componentKeys.all });
}

/** The path segment for one component, which is a tool name rather than an opaque id. */
function componentPath(name: string): string {
  return `/api/components/${encodeURIComponent(name)}`;
}

/**
 * Whether one Bot may answer with a component.
 *
 * Granting posts to the collection; withholding deletes from it. The absence of a grant is what
 * withholds it, so there is no third state to send.
 */
export function setComponentGrantMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      name: string;
      agentId: string;
      granted: boolean;
    }) => {
      await (variables.granted
        ? componentRequest(`${componentPath(variables.name)}/grants`, {
            method: "POST",
            body: { agentId: variables.agentId },
          })
        : componentRequest(
            `${componentPath(variables.name)}/grants/${encodeURIComponent(variables.agentId)}`,
            { method: "DELETE" },
          ));
    },
    onSuccess: () => invalidateComponents(queryClient),
  });
}

/** Whether a component may read one deployment data function. */
export function setComponentFunctionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      name: string;
      functionName: string;
      granted: boolean;
    }) => {
      await (variables.granted
        ? componentRequest(`${componentPath(variables.name)}/functions`, {
            method: "POST",
            body: { function: variables.functionName },
          })
        : componentRequest(
            `${componentPath(variables.name)}/functions/${encodeURIComponent(variables.functionName)}`,
            { method: "DELETE" },
          ));
    },
    onSuccess: () => invalidateComponents(queryClient),
  });
}

/** Whether any Bot is told the component exists. */
export function setComponentPublishedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { name: string; published: boolean }) => {
      await componentRequest(`${componentPath(variables.name)}/publication`, {
        method: "POST",
        body: { published: variables.published },
      });
    },
    onSuccess: () => invalidateComponents(queryClient),
  });
}

/**
 * The description the model will read once it is published. Saving it changes nothing a Bot can see
 * until publication, which is why it is a separate write.
 */
export function saveComponentDraftMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { name: string; description: string }) => {
      await componentRequest(`${componentPath(variables.name)}/draft`, {
        method: "PUT",
        body: { description: variables.description },
      });
    },
    onSuccess: () => invalidateComponents(queryClient),
  });
}
