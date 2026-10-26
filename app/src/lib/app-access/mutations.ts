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

/**
 * An administrator's one press: file the request this app needs on this Bot and approve it in the
 * same step, through the inbox's own approval — the app switched on and its read-only actions
 * granted, with the trail two presses would leave. Answers with what changed, or the sentence for
 * what is missing (an OAuth client, a broker key) when it cannot be done from here.
 */
export function approveBotAppMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      agentId: string;
      app: string;
    }): Promise<{
      request: AppAccessRequest;
      enabled: boolean;
      granted: string[];
    }> => {
      const response = await client(
        `/api/plugins/for/${encodeURIComponent(variables.agentId)}/apps/${encodeURIComponent(variables.app)}/approve`,
        { method: "POST", fallback: "Couldn't turn that app on. Try again." },
      );
      return response.json();
    },
    onSettled: () => refresh(queryClient),
  });
}

/**
 * Give one of your own apps to a Bot you own: its read-only actions, run on whoever is asking's own
 * account. A plain function as well as a mutation, because the New Bot sheet gives several in a row
 * right after the Bot is made, outside any one press.
 */
export async function giveBotApp(variables: {
  agentId: string;
  app: string;
}): Promise<{ granted: string[] }> {
  const response = await client(
    `/api/plugins/for/${encodeURIComponent(variables.agentId)}/apps/${encodeURIComponent(variables.app)}/give`,
    { method: "POST", fallback: "Couldn't give that app to this Bot." },
  );
  return response.json();
}

/** One press of "Let it use your Gmail", on the card or a Bot's page. */
export function giveBotAppMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: giveBotApp,
    onSettled: () => refresh(queryClient),
  });
}

/** Take back what you gave a Bot you own. Anything an admin gave it stays. */
export function takeBackBotAppMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      agentId: string;
      app: string;
    }): Promise<{ revoked: string[] }> => {
      const response = await client(
        `/api/plugins/for/${encodeURIComponent(variables.agentId)}/apps/${encodeURIComponent(variables.app)}/give`,
        { method: "DELETE", fallback: "Couldn't take that app back." },
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
