import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { batchUpdateBotGrants } from "@/lib/api/generated/bot-grants/bot-grants";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { invalidatePlugins } from "@/lib/plugins/mutations";
import {
  type SharedUseApproval,
  sharedUseKeys,
} from "@/lib/plugins/shared-use";
import { appGrantKeys } from "./queries";

const FALLBACK = "Couldn't change that Bot.";

/** Where a saved set came from: the sentence the model chose it from. */
export type AppGrantAuthoring = { source: "english"; text: string };

/**
 * Turn one app's actions on and off for one Bot as one change, with the sentence they were chosen
 * from. The server holds every action to the checks the page's switches are held to, refuses the
 * whole change if any fails, and records it once with the sentence.
 */
export const saveAppGrantsMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      app: string;
      add: string[];
      remove: string[];
      authoring?: AppGrantAuthoring;
      /** Who may use a Shared app's one account through this Bot, when none is approved yet. */
      approval?: SharedUseApproval;
    }) =>
      batchUpdateBotGrants(
        organizationId(),
        variables.agentId,
        {
          appId: variables.app,
          add: variables.add,
          remove: variables.remove,
          ...(variables.authoring ? { authoring: variables.authoring } : {}),
          ...(variables.approval ? { approval: variables.approval } : {}),
        },
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      ),
    onSuccess: (_response, variables) =>
      Promise.all([
        invalidatePlugins(queryClient),
        queryClient.invalidateQueries({ queryKey: appGrantKeys.all }),
        queryClient.invalidateQueries({
          queryKey: sharedUseKeys.bot(variables.agentId),
        }),
      ]),
  });
