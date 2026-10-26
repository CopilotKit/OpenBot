import {
  connectAppRefusal,
  SHOW_APP_ACCESS_TOOL,
} from "@openbot/shared/connect-prompt";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import type { AppAccess, AppAccessState } from "./app-access";
import { ownerAppsAllowed } from "./owner-grants";
import type {
  AppDirectory,
  SharedAudienceCheck,
} from "./plugin-store/app-access";
import type { PluginStore } from "./store";

/**
 * The tool every Bot holds for putting a work app's state in front of the person asking.
 *
 * WHY A TOOL AND NOT A SENTENCE. A Bot that met an app it does not hold used to be told to "say an
 * administrator can grant it", and did — correctly, and uselessly: the person was handed the name of
 * a role and no way to reach it, about an app the Bot could have had all along. The other ways an
 * app is out of reach already drew a card, because each of them is a refused call and the refusal
 * carries one (`@openbot/shared/connect-prompt`). An app the Bot holds nothing for is never called,
 * so nothing was refused and there was nothing to draw. This is the call.
 *
 * THE ANSWER IS THE SAME MARKER A REFUSAL CARRIES, with `reason: "access"`, so the transcript draws
 * it with the same card, and the card asks the server for the app's state for this person and this
 * Bot when it is drawn — never trusting what this answer said, which is only what was true when the
 * model asked. The sentence after the marker is what the model reads: the state in words, and what
 * the card offers, so it does not go on to repeat the card at length.
 *
 * A READ, AND ONLY EVER ONE. Nothing here enables, grants or files anything — pressing Request
 * access on the card does that, as the person, through the same route the Bot page uses, where the
 * server decides what is asked for. So the tool is safe to hand every Bot: the worst a model can do
 * with it is show somebody an accurate card about an app they did not ask about.
 */
export function appAccessTools(options: {
  store: Pick<PluginStore, "inspectApp">;
  botId: string;
  actorId: string;
  composioConfigured: boolean;
  /** Names an app this deployment has no row for. Absent without the broker's key. */
  directory?: AppDirectory;
  /** The shared-use gate's answer for this person, so a Shared app it would refuse says so. */
  sharedAudience?: SharedAudienceCheck;
}): GrantedTool[] {
  const parameters = z
    .object({
      app: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe(
          "The app's name (Gmail, Slack, Google Drive) or its id as your instructions list it.",
        ),
    })
    .strict();
  return [
    {
      name: SHOW_APP_ACCESS_TOOL,
      ref: `app-access/${SHOW_APP_ACCESS_TOOL}`,
      description:
        "Show the person a card saying whether they can use one work app through you, and the one thing that would let them: connecting their own account, or asking an administrator to switch the app on, grant it to you, or connect its shared account. Call it whenever a question needs an app you hold no tools for, instead of only saying it is missing.",
      parameters,
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success) return "Name the app to show.";
        const { app } = parsed.data;
        const inspected = await options.store.inspectApp({
          app,
          agentId: options.botId,
          userId: options.actorId || null,
          composioConfigured: options.composioConfigured,
          ...(options.directory ? { directory: options.directory } : {}),
          ...(options.sharedAudience
            ? { sharedAudience: options.sharedAudience }
            : {}),
          ownerGrantsAllowed: options.actorId
            ? await ownerAppsAllowed(options.actorId)
            : false,
        });
        /*
         * No card for an app nobody can name. A card about it would have nothing to ask the server
         * and nothing to offer, and the model is better told plainly so it can say so.
         */
        if (!inspected)
          return `This deployment has no app called ${app}, so there is nothing to show. Say so plainly; do not browse to it instead.`;
        const { access } = inspected;
        return connectAppRefusal({
          serverId: access.key,
          title: access.displayName,
          agentId: options.botId,
          reason: "access",
          // Lets a card drawn later tell "ready since" from "ready all along".
          blocked: access.state !== "ready",
          message: toldTheModel(access),
        });
      },
    },
  ];
}

/**
 * What the model reads about the card it just put on screen: the state in words, and that the card
 * already offers the next step, so the reply around it is a sentence rather than a set of
 * instructions the person can already see.
 */
function toldTheModel(access: AppAccess): string {
  const name = access.displayName;
  const owners = access.accountHolder === "owner";
  const said: Record<AppAccessState, string> = {
    ready: access.asksFirst
      ? `${name} is ready for this person to use through you, on their own account; the first call will ask them to allow that. Use its tools rather than the card.`
      : `${name} is ready for this person to use through you. Use its tools rather than the card.`,
    not_connected: `${name} is granted to you, and this person has not connected their own account. The card in front of them offers Connect; ask them to try again once they have.`,
    reconnect: owners
      ? `${name} is granted to you and runs on your owner's account, whose connection needs reconnecting. Only your owner can reconnect it; the card in front of the person says so.`
      : `${name} is granted to you, and this person's connection needs reconnecting. The card in front of them offers Reconnect; ask them to try again once they have.`,
    shared_not_connected: `${name} uses one shared account for this deployment, and an administrator has not connected it yet. The card in front of the person lets them ask an administrator for it.`,
    shared_not_approved: `${name} uses one shared account for this deployment, and you reach more people than an administrator approved for it, so its calls are refused. Only an administrator can approve that; the card in front of the person says so.`,
    disabled: `${name} is switched off on this deployment. The card in front of the person lets them ask an administrator to switch it on.`,
    not_granted: `${name} is switched on, and you have not been granted it. The card in front of the person lets them ask an administrator to grant it to you.`,
    owner_grantable: `${name} is switched on, and you have not been given it. This person owns you and can give it to you themselves: the card in front of them asks whether to let you use their ${name}. Ask them to try again once they have.`,
  };
  return `${said[access.state]} Do not browse to its website or ask them to sign in there.`;
}
