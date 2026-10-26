import type { ConnectPrompt } from "@openbot/shared/connect-prompt";
import { useQuery } from "@tanstack/react-query";
import {
  AppAccessAction,
  appAccessSentence,
} from "@/components/plugins/app-access-action";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button } from "@/components/ui/button";
import { agentQueryOptions } from "@/lib/agents/queries";
import { type AppAccess, botAppQueryOptions } from "@/lib/app-access/queries";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { type CardPlace, useCarryOn } from "@/lib/copilot/carry-on";
import { ConnectAppCard } from "./connect-app-card";

/**
 * A work app a Bot could not use, in front of the person, with the one thing that would let it.
 *
 * WHAT DRAWS ONE. Every way an app is out of reach for a call now reaches the transcript carrying
 * the same marker (`@openbot/shared/connect-prompt`): a person who has not connected, a Shared app
 * with no team account, an account the vendor has lost, and — with no call refused at all — the
 * `show_app_access` tool a Bot calls for an app it holds nothing for, switched off or not granted.
 * They used to end in three different places: a card with Connect, a sentence telling the person to
 * ask an administrator, and a sentence naming a settings page.
 *
 * LIVE, NEVER WHAT THE REFUSAL SAID. The marker names an app and a Bot; the state is asked of the
 * server for this person on that Bot when the card is drawn, and the shared app-access piece draws
 * that with the button that goes with it. A card scrolled back to an hour later says what is true
 * now — connected since, granted since, the request approved — and never offers a step that has
 * already been taken. Every write those buttons make refreshes the same key, so the card follows.
 *
 * THE ONE PLACE THE REFUSAL WINS. The call that finds an account gone at the vendor deletes its row,
 * so the live state normally says so itself. A refusal from before that, over a row that still
 * stands, reads `ready` live — and this card is drawn over exactly the call that failed. So a
 * `reconnect` or `shared` refusal over a live `ready` is drawn as the refusal says — unless the
 * account was connected after the refusal, which is the reconnection. Anything else live is newer
 * than the refusal and is drawn as it is.
 *
 * AND THEN THE TASK CARRIES ON. Once the app is ready — connected in the other tab, switched on and
 * given by an admin — the card sends the conversation on by itself, or offers Continue where it was
 * not watching when that happened. `place` is where the card sits in its conversation, without
 * which (a card drawn outside one) it only says the app is ready. See `lib/copilot/carry-on.ts`.
 */
export function AppAccessCard({
  prompt,
  place,
}: {
  prompt: ConnectPrompt;
  place?: CardPlace;
}) {
  const declared = useDeclaredBotId();
  const agentId = prompt.agentId ?? declared;
  /*
   * A refusal from before refusals named their Bot, on a surface that declared none: there is no Bot
   * to ask about, so the card it was drawn as then is the card it is drawn as now.
   */
  if (!agentId) return <ConnectAppCard {...prompt} place={place} />;
  return <LiveAppAccessCard agentId={agentId} place={place} prompt={prompt} />;
}

function LiveAppAccessCard({
  agentId,
  place,
  prompt,
}: {
  agentId: string;
  place: CardPlace | undefined;
  prompt: ConnectPrompt;
}) {
  const live = useQuery({
    ...botAppQueryOptions(agentId, prompt.serverId),
    /*
     * Read again whenever this tab has the focus back. What changes the state usually happens in
     * another tab — a consent screen, an admin's page for the app — and the person returning here
     * is the moment the card should say what is true now.
     */
    refetchOnWindowFocus: true,
  });
  const access = live.data ? asRefused(live.data, prompt) : null;
  const name = access?.displayName ?? prompt.title;
  // Only asked for by "Let Research Bot use your Gmail?", the one sentence that names the Bot.
  const bot = useQuery(agentQueryOptions(agentId)).data?.name;
  const { carried, offer } = useCarryOn({
    place,
    ready: access ? access.state === "ready" : null,
    // A refusal was blocked by definition; `show_app_access` says what it found.
    blockedWhenAsked: prompt.reason !== "access" || prompt.blocked === true,
    app: name,
  });
  /*
   * A read that failed falls back to what this card was before it read anything, where that was a
   * card at all: a person's own missing connection still gets its Connect button. The other reasons
   * had only ever been a sentence, and the sentence is what is left.
   */
  if (live.error && (prompt.reason ?? "connect") === "connect")
    return <ConnectAppCard {...prompt} place={place} />;
  return (
    <div
      className="my-2 flex w-full max-w-2xl flex-col gap-3 rounded-xl border border-border p-4"
      data-app-access={prompt.serverId}
      data-state={access?.state}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border">
          <PluginLogo logo={access?.logo} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="font-medium text-sm">{name}</p>
          {/*
           * Nothing while the read is open — no placeholder, per the data-access rule — and a
           * sentence of the card's own if it failed. NOT the refusal's message: that was written for
           * the model ("do not browse to its website"), and reads as an instruction to the wrong
           * reader. Otherwise the state, which is the server's.
           */}
          {live.isPending ? null : access ? (
            <p className="text-muted-foreground text-sm">
              {access.state !== "ready"
                ? refusedSentence(access, prompt, bot)
                : carried || offer
                  ? `${name} is ready now.`
                  : prompt.reason !== "access"
                    ? `${name} is ready now. Ask again and the Bot can use it.`
                    : refusedSentence(access, prompt, bot)}
            </p>
          ) : (
            <p className="text-muted-foreground text-sm" role="alert">
              {name}'s status couldn't be loaded. Try again in a moment.
            </p>
          )}
        </div>
      </div>
      {access && access.state !== "ready" ? (
        <div className="flex justify-end">
          <AppAccessAction access={access} agentId={agentId} />
        </div>
      ) : offer ? (
        <div className="flex justify-end">
          <Button onClick={offer} size="sm">
            Continue
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The live state, or the refusal's where only the refusal can know: an account the vendor lost,
 * which the server still reads as `ready`. See the card's own comment.
 *
 * A lost team account is drawn as not connected with NO request to file — the server would answer
 * any request 409, since as far as it knows the account is fine — so the sentence says whose move it
 * is and the button is left out rather than offered and refused.
 *
 * A lost account on somebody else's Team Bot keeps the live `accountHolder`. Where that is the
 * owner's account, the override reads as the owner's reconnection — the sentence says only the owner
 * can, and `AppAccessAction` offers nothing — because a Reconnect pressed here would connect this
 * person's own account, which the Bot does not run on.
 */
function asRefused(live: AppAccess, prompt: ConnectPrompt): AppAccess {
  if (live.state !== "ready") return live;
  /*
   * Connected again since the refusal: that is the reconnection, and the live `ready` is true.
   * Compared as instants rather than as strings, because the two come from different clocks'
   * formatters and only the instant is the same.
   */
  if (
    prompt.at &&
    live.connectedAt &&
    Date.parse(live.connectedAt) > Date.parse(prompt.at)
  )
    return live;
  if (prompt.reason === "reconnect") return { ...live, state: "reconnect" };
  if (prompt.reason === "shared")
    return {
      ...live,
      state: "shared_not_connected",
      requestKind: null,
      request: null,
    };
  return live;
}

/** As the shared sentence, except a lost team account, which needs reconnecting rather than connecting. */
function refusedSentence(
  access: AppAccess,
  prompt: ConnectPrompt,
  bot?: string,
): string {
  if (
    access.state === "shared_not_connected" &&
    prompt.reason === "shared" &&
    !access.requestKind
  )
    return `Your organisation's ${access.displayName} account needs reconnecting. Only an admin can reconnect it.`;
  return appAccessSentence(access, bot);
}
