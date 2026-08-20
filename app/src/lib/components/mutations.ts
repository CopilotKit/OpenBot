import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { componentKeys } from "./queries";

/**
 * Writes against a component's governance: publication, per-Bot grants, per-function grants, and the
 * draft description.
 *
 * Every one of these is a decision the server records and may refuse, so none of them patch the
 * cache — the list is invalidated and the screen re-reads whatever was actually decided.
 */

/** The sentence for every write here, for the rare case the server sends none of its own. */
const FALLBACK = "Component operation failed";

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
        ? client(`${componentPath(variables.name)}/grants`, {
            method: "POST",
            body: { agentId: variables.agentId },
            fallback: FALLBACK,
          })
        : client(
            `${componentPath(variables.name)}/grants/${encodeURIComponent(variables.agentId)}`,
            { method: "DELETE", fallback: FALLBACK },
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
        ? client(`${componentPath(variables.name)}/functions`, {
            method: "POST",
            body: { function: variables.functionName },
            fallback: FALLBACK,
          })
        : client(
            `${componentPath(variables.name)}/functions/${encodeURIComponent(variables.functionName)}`,
            { method: "DELETE", fallback: FALLBACK },
          ));
    },
    onSuccess: () => invalidateComponents(queryClient),
  });
}

/** Whether any Bot is told the component exists. */
export function setComponentPublishedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { name: string; published: boolean }) => {
      await client(`${componentPath(variables.name)}/publication`, {
        method: "POST",
        body: { published: variables.published },
        fallback: FALLBACK,
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
      await client(`${componentPath(variables.name)}/draft`, {
        method: "PUT",
        body: { description: variables.description },
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateComponents(queryClient),
  });
}
