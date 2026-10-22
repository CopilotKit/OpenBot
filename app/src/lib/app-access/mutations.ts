import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { pluginKeys } from "@/lib/plugins/queries";
import type { AppAccessRequest } from "./queries";

const FALLBACK = "That request could not be sent.";

/*
 * EVERY PLUGIN SCREEN, AND ON `onSettled`, for the reason `invalidatePlugins` in
 * `lib/plugins/mutations.ts` sets out: approving does several durable things in a row — switch the
 * app on, grant its tools, record a Shared approval — and a refusal partway leaves the earlier ones
 * standing. The app-access keys sit under `pluginKeys.all`, so one invalidation covers the Bot page,
 * the card, the inbox and the plugin screens the approval just changed.
 */
const refresh = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: pluginKeys.all });

/**
 * Ask an administrator for access to one app on one Bot. The server decides what is asked for from
 * the app's state; a second press answers with the request already pending (`created: false`).
 */
export function requestAppAccessMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      agentId: string;
      app: string;
    }): Promise<{ request: AppAccessRequest; created: boolean }> => {
      const response = await client("/api/plugins/access-requests", {
        method: "POST",
        body: variables,
        fallback: FALLBACK,
      });
      return response.json();
    },
    onSettled: () => refresh(queryClient),
  });
}

/** Withdraw one's own pending request. */
export function cancelAppAccessRequestMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (id: string): Promise<AppAccessRequest> =>
      client(
        `/api/plugins/access-requests/${encodeURIComponent(id)}`,
        "request",
        {
          method: "DELETE",
          fallback: "That request could not be withdrawn.",
        },
      ),
    onSettled: () => refresh(queryClient),
  });
}

/**
 * Approve a request by doing what it asks. `refs` names the tools to grant; absent, the Bot is
 * granted the app's read-only tools only, and an app with none is answered 409 with a sentence
 * pointing at the Bot's page, where the others are chosen. Answers with what changed.
 */
export function approveAppAccessRequestMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (variables: {
      id: string;
      refs?: string[];
    }): Promise<{
      request: AppAccessRequest;
      enabled: boolean;
      granted: string[];
    }> => {
      const response = await client(
        `/api/plugins/access-requests/${encodeURIComponent(variables.id)}/approve`,
        {
          method: "POST",
          ...(variables.refs ? { body: { refs: variables.refs } } : {}),
          fallback: "That request could not be approved.",
        },
      );
      return response.json();
    },
    onSettled: () => refresh(queryClient),
  });
}

/** Dismiss a request without changing anything else. */
export function dismissAppAccessRequestMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (id: string): Promise<AppAccessRequest> =>
      client(
        `/api/plugins/access-requests/${encodeURIComponent(id)}/dismiss`,
        "request",
        { method: "POST", fallback: "That request could not be dismissed." },
      ),
    onSettled: () => refresh(queryClient),
  });
}
