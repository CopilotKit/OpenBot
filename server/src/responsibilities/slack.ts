/**
 * Slack triggers: the contract the Slack pairing (OpenTag) calls once it has verified a Slack
 * Events API delivery with the app's signing secret.
 *
 *   import { ingestSlackEvent } from "../responsibilities/slack";
 *   await ingestSlackEvent({ teamId, eventId, eventTime, type, channelId, userId, ts, ... });
 *
 * The pairing owns Slack authentication, the workspace install and which OpenBot Bot a Slack app
 * speaks for; this module owns deciding which responsibilities a verified event fires. It never
 * throws for an event nobody listens to: it returns what it did.
 *
 * Matching (all must hold):
 *  - trigger kind `slack` and its `teamId` equals the event's. Who wrote the message does not
 *    matter: the ingest then requires the trigger's owner to have linked Slack and to be in the
 *    channel, so an owner hears colleagues in their channels and nobody else's;
 *  - the event is not from a bot and happened at or after the trigger was created (pre-existing
 *    messages, backfills and edits of old messages are ignored);
 *  - the channel is in the trigger's `channels`, or that list is empty (every channel the Bot is in);
 *  - mode `mention` fires on `app_mention`; `phrase` on a `message` containing any phrase
 *    (case-insensitive); `message` on any `message`; `reaction` on `reaction_added` whose name is
 *    listed (or any, when none are listed). A `message` event is never treated as a mention, since
 *    Slack sends both `message` and `app_mention` for one mention and that would fire twice.
 * Dedup is by the Events API envelope `event_id`, per trigger, so Slack's retries are harmless.
 */
import { z } from "zod";
import {
  type DeliveryOutcome,
  deliverToTrigger,
  type TriggerIngressDeps,
} from "./trigger-routes";
import {
  type ResolvedTrigger,
  type SlackAccess,
  slackAccessAllows,
} from "./triggers";

export const slackTriggerEventSchema = z
  .object({
    /** Envelope `team_id`. */
    teamId: z.string().regex(/^[A-Z0-9]{2,32}$/),
    /** Envelope `event_id` (Ev…): the dedup key. */
    eventId: z.string().min(1).max(128),
    /** Envelope `event_time`, unix seconds. */
    eventTime: z.number().int().positive(),
    type: z.enum(["message", "app_mention", "reaction_added"]),
    /** Channel of the message, or `item.channel` for a reaction. */
    channelId: z.string().min(1).max(64),
    /** Author of the message, or the person who reacted. */
    userId: z.string().min(1).max(64),
    /** Message `ts`, or the reacted-to `item.ts`. */
    ts: z.string().regex(/^\d+\.\d+$/),
    threadTs: z
      .string()
      .regex(/^\d+\.\d+$/)
      .optional(),
    /** Message text (message / app_mention). */
    text: z.string().max(40_000).optional(),
    /** reaction_added: emoji name without colons. */
    reaction: z.string().max(100).optional(),
    /** Set when the author is a bot (`bot_id` present) or the message has a `subtype`. */
    isBot: z.boolean().optional(),
    subtype: z.string().max(64).optional(),
    /** Permalink when the pairing has one, for the Bot to cite. */
    permalink: z.string().url().max(2000).optional(),
  })
  .strict();
export type SlackTriggerEvent = z.infer<typeof slackTriggerEventSchema>;

export type SlackIngestResult = {
  matched: number;
  deliveries: {
    triggerId: string;
    responsibilityId: string;
    outcome: DeliveryOutcome;
  }[];
};

/** Whether one trigger listens for this event; pure, so it is tested without a database. */
export function slackTriggerMatches(
  trigger: ResolvedTrigger,
  event: SlackTriggerEvent,
): boolean {
  // The author's identity never decides whose trigger fires. The ingest checks each owner's own
  // access to the channel, so a colleague who never linked OpenBot still fires the owner's trigger.
  const config = trigger.config;
  if (config.kind !== "slack" || config.teamId !== event.teamId) return false;
  if (event.isBot || event.subtype) return false;
  // Pre-existing messages never fire: both the delivery and the message itself must be new.
  const created = Math.floor(trigger.createdAt.getTime() / 1000);
  if (event.eventTime < created || Number.parseFloat(event.ts) < created)
    return false;
  if (config.channels.length > 0 && !config.channels.includes(event.channelId))
    return false;
  const text = (event.text ?? "").toLowerCase();
  switch (config.mode) {
    case "mention":
      return event.type === "app_mention";
    case "message":
      return event.type === "message";
    case "phrase":
      return (
        event.type === "message" &&
        config.phrases.some((phrase) => text.includes(phrase.toLowerCase()))
      );
    case "reaction":
      return (
        event.type === "reaction_added" &&
        !!event.reaction &&
        (config.reactions.length === 0 ||
          config.reactions.includes(event.reaction))
      );
  }
}

export function createSlackTriggerIngest(
  deps: TriggerIngressDeps & { slackAccess?: () => SlackAccess | undefined },
) {
  return async function ingestSlackEvent(
    input: unknown,
  ): Promise<SlackIngestResult> {
    const event = slackTriggerEventSchema.parse(input);
    const triggers = await deps.directory.slackTriggers(event.teamId);
    const deliveries: SlackIngestResult["deliveries"] = [];
    const verdicts = new Map<string, Promise<string | null>>();
    for (const trigger of triggers) {
      if (!slackTriggerMatches(trigger, event)) continue;
      // Access is re-checked for every event, not only when the trigger was saved: an owner who
      // unlinked Slack or left the channel stops hearing it. Fail closed.
      let verdict = verdicts.get(trigger.ownerUserId);
      if (!verdict) {
        verdict = slackAccessAllows(
          deps.slackAccess?.(),
          trigger.ownerUserId,
          event.teamId,
          [event.channelId],
        );
        verdicts.set(trigger.ownerUserId, verdict);
      }
      const refusal = await verdict;
      if (refusal) {
        deliveries.push({
          triggerId: trigger.id,
          responsibilityId: trigger.responsibilityId,
          outcome: { status: "ignored", reason: refusal },
        });
        continue;
      }
      const payload = event;
      deliveries.push({
        triggerId: trigger.id,
        responsibilityId: trigger.responsibilityId,
        outcome: await deliverToTrigger(
          deps,
          trigger,
          {
            deliveryId: event.eventId,
            type: event.type,
            payload: { ...payload, text: event.text?.slice(0, 16_000) },
          },
          true,
        ),
      });
    }
    return {
      matched: deliveries.filter(
        (delivery) => delivery.outcome.status === "queued",
      ).length,
      deliveries,
    };
  };
}

let installed: ((input: unknown) => Promise<SlackIngestResult>) | null = null;
/** Called once by the server assembly, like `useRoutineTools`. */
export function useSlackTriggerIngest(
  ingest: (input: unknown) => Promise<SlackIngestResult>,
) {
  installed = ingest;
}
/**
 * The pairing lane's entry point. Throws when the deployment never wired responsibilities, so a
 * missing wire is loud rather than every Slack trigger silently never firing.
 */
export function ingestSlackEvent(
  input: SlackTriggerEvent,
): Promise<SlackIngestResult> {
  if (!installed)
    throw new Error("Slack triggers are not wired on this deployment.");
  return installed(input);
}

let membership: SlackAccess["isMember"] = null;
/**
 * Installed by the Slack pairing lane: whether a Slack user is a member of a channel, answered from
 * Slack (`conversations.members` / `users.conversations` with the workspace's bot token), cached
 * briefly, and false on any Slack API error. Until installed, Slack triggers are refused.
 */
export function useSlackChannelMembership(check: SlackAccess["isMember"]) {
  membership = check;
}
/** The access policy the trigger store and ingest read at call time. */
export function slackAccessFrom(
  linkedIdentity: SlackAccess["linkedIdentity"],
): () => SlackAccess {
  return () => ({ linkedIdentity, isMember: membership });
}
