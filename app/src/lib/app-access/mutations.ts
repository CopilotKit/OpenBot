import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  approveAppAccessRequest,
  createAppAccessRequest,
  deleteAppAccessRequest,
  dismissAppAccessRequest,
} from "@/lib/api/generated/app-access-requests/app-access-requests";
import {
  approveBotApp,
  giveBotApp as giveBotAppOperation,
  takeBackBotApp,
} from "@/lib/api/generated/bot-grants/bot-grants";
import type { AppAccessApproval } from "@/lib/api/generated/model";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { invalidatePlugins } from "@/lib/plugins/mutations";
import { type AppAccessRequest, accessRequestOf } from "./queries";

const FALLBACK = "That request could not be sent.";

/*
 * EVERY PLUGIN SCREEN, AND ON `onSettled`, for the reason `invalidatePlugins` in
 * `lib/plugins/mutations.ts` sets out: approving does several durable things in a row — switch the
 * app on, grant its tools, record a Shared approval — and a refusal partway leaves the earlier ones
 * standing. The app-access keys sit under `pluginKeys.all`, so one invalidation covers the Bot page,
 * the card, the inbox and the plugin screens the approval just changed.
 */
const refresh = (queryClient: QueryClient) => invalidatePlugins(queryClient);

/** What approving does, as the inbox and the card read it. */
function approvalOf(approval: AppAccessApproval): {
  request: AppAccessRequest;
  enabled: boolean;
  granted: string[];
} {
  return {
    request: accessRequestOf(approval.appAccessRequest),
    enabled: approval.enabled,
    granted: approval.granted,
  };
}

/**
 * Ask an administrator for access to one app on one Bot. The server decides what is asked for from
 * the app's state; a second press answers with the request already pending.
 */
export function requestAppAccessMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      agentId: string;
      app: string;
      /** The actions asked for, for a Bot that holds the app and needs these too. */
      actions?: string[];
    }): Promise<{ request: AppAccessRequest }> => ({
      request: accessRequestOf(
        await createAppAccessRequest(
          organizationId(),
          {
            botId: variables.agentId,
            appId: variables.app,
            ...actionsBody(variables.actions),
          },
          { "Idempotency-Key": idempotencyKey() },
          { fallback: FALLBACK },
        ),
      ),
    }),
    onSettled: () => refresh(queryClient),
  });
}

/**
 * Ask an admin to add an app nobody has added yet, for everyone in the organization, with no Bot
 * named. `app` is the directory entry's slug. A second press answers the request already waiting.
 */
export function requestAppMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (app: string): Promise<AppAccessRequest> =>
      accessRequestOf(
        await createAppAccessRequest(
          organizationId(),
          { appId: app },
          { "Idempotency-Key": idempotencyKey() },
          { fallback: "Couldn't send that request. Try again." },
        ),
      ),
    onSettled: () => refresh(queryClient),
  });
}

/** Withdraw one's own pending request. */
export function cancelAppAccessRequestMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (id: string): Promise<void> =>
      deleteAppAccessRequest(
        organizationId(),
        id,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "That request could not be withdrawn." },
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
    }> =>
      approvalOf(
        await approveAppAccessRequest(
          organizationId(),
          variables.id,
          { "Idempotency-Key": idempotencyKey() },
          // No actions named sends no body: the Bot then gets the actions that only read.
          variables.refs ? { actions: variables.refs } : undefined,
          { fallback: "That request could not be approved." },
        ),
      ),
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
      /** The actions to give, for a Bot that holds the app and needs these too. */
      actions?: string[];
    }): Promise<{
      request: AppAccessRequest;
      enabled: boolean;
      granted: string[];
    }> =>
      approvalOf(
        await approveBotApp(
          organizationId(),
          variables.agentId,
          variables.app,
          { "Idempotency-Key": idempotencyKey() },
          actionsBody(variables.actions),
          { fallback: "Couldn't turn that app on. Try again." },
        ),
      ),
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
  /** The actions to give, for a Bot that holds the app and needs these too. */
  actions?: string[];
}): Promise<{ granted: string[] }> {
  const given = await giveBotAppOperation(
    organizationId(),
    variables.agentId,
    variables.app,
    { "Idempotency-Key": idempotencyKey() },
    actionsBody(variables.actions),
    { fallback: "Couldn't give that app to this Bot." },
  );
  return { granted: given.given };
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
      const taken = await takeBackBotApp(
        organizationId(),
        variables.agentId,
        variables.app,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: "Couldn't take that app back." },
      );
      return { revoked: taken.takenBack };
    },
    onSettled: () => refresh(queryClient),
  });
}

/** Dismiss a request without changing anything else. */
export function dismissAppAccessRequestMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<AppAccessRequest> =>
      accessRequestOf(
        await dismissAppAccessRequest(
          organizationId(),
          id,
          { "Idempotency-Key": idempotencyKey() },
          { fallback: "That request could not be dismissed." },
        ),
      ),
    onSettled: () => refresh(queryClient),
  });
}

/** The body naming the actions a press gives, or none: the server then gives the read-only ones. */
function actionsBody(actions: string[] | undefined) {
  return actions && actions.length > 0 ? { actions } : undefined;
}
