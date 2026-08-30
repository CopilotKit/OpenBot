import type { ChannelIdentityContext } from "@copilotkit/channels";
import type { SlackIdentityResult } from "./identity-linker";

export type Timer = { cancel(): void };

export type SlackIngress = {
  identityContext: ChannelIdentityContext;
  identityResult: SlackIdentityResult;
};

export type SlackIngressSelector = {
  provider: "slack";
  providerActorId: string;
  applicationUserId: string | null;
};

export type SlackInteractionSelector = SlackIngressSelector;
export type LinkedSlackIngress = SlackIngress & {
  identityResult: Extract<SlackIdentityResult, { kind: "linked" }>;
};

export type SlackIngressTimer = {
  after(milliseconds: number, callback: () => void): Timer;
};

const INGRESS_TTL_MS = 30_000;
const EVENT_ID_ERROR = "Managed Slack ingress requires an event id.";

export function providerThreadIdFromIdentity(
  context: ChannelIdentityContext,
): string {
  const eventThreadId = context.event.threadId;
  return typeof eventThreadId === "string" && eventThreadId.trim()
    ? eventThreadId
    : context.conversation.id;
}

type RememberedIngress = {
  ingress: SlackIngress;
  timer: Timer;
};

type RememberedLinkedInteraction = RememberedIngress & {
  ingress: LinkedSlackIngress;
};

const systemTimer: SlackIngressTimer = {
  after(milliseconds, callback) {
    const timeout = setTimeout(callback, milliseconds);
    return { cancel: () => clearTimeout(timeout) };
  },
};

function requiredEventId(eventId: string | undefined): string {
  if (!eventId?.trim()) throw new Error(EVENT_ID_ERROR);
  return eventId.trim();
}

/** One-use, short-lived identity facts bridging managed Channels ingress to agent execution. */
export class SlackIngressRegistry {
  private readonly entries = new Map<string, RememberedIngress[]>();

  constructor(private readonly timer: SlackIngressTimer = systemTimer) {}

  remember(eventId: string | undefined, ingress: SlackIngress): void {
    const id = requiredEventId(eventId);
    const rememberedForEvent = this.entries.get(id) ?? [];
    const priorIndex = rememberedForEvent.findIndex(({ ingress: prior }) =>
      samePrincipal(prior, ingress),
    );
    const prior = rememberedForEvent[priorIndex];
    prior?.timer.cancel();

    let remembered: RememberedIngress;
    const timer = this.timer.after(INGRESS_TTL_MS, () => {
      this.remove(id, remembered);
    });
    remembered = { ingress, timer };
    if (priorIndex >= 0) rememberedForEvent[priorIndex] = remembered;
    else rememberedForEvent.push(remembered);
    this.entries.set(id, rememberedForEvent);
  }

  take(
    eventId: string | undefined,
    selector: SlackIngressSelector,
  ): SlackIngress | null {
    const id = requiredEventId(eventId);
    const matches = (this.entries.get(id) ?? []).filter(({ ingress }) =>
      matchesSelector(ingress, selector),
    );
    if (matches.length !== 1) return null;
    const [remembered] = matches;
    if (!remembered) return null;
    this.remove(id, remembered);
    remembered.timer.cancel();
    return remembered.ingress;
  }

  /** Consume the one live interaction principal that Channels resolved immediately before click dispatch. */
  takeInteraction(
    selector: SlackInteractionSelector,
  ): LinkedSlackIngress | null {
    const matches = [...this.entries.entries()].flatMap(([id, entries]) =>
      entries
        .filter(isLinkedInteraction)
        .filter(({ ingress }) => matchesSelector(ingress, selector))
        .map((remembered) => ({ id, remembered })),
    );
    // Ambiguity is itself untrusted. Burn every candidate so none can be replayed after expiry or
    // after another overlapping interaction disappears.
    if (matches.length !== 1) {
      for (const { id, remembered } of matches) {
        this.remove(id, remembered);
        remembered.timer.cancel();
      }
      return null;
    }
    const [{ id, remembered }] = matches;
    this.remove(id, remembered);
    remembered.timer.cancel();
    return remembered.ingress;
  }

  private remove(id: string, remembered: RememberedIngress): void {
    const remaining = (this.entries.get(id) ?? []).filter(
      (entry) => entry !== remembered,
    );
    if (remaining.length > 0) this.entries.set(id, remaining);
    else this.entries.delete(id);
  }
}

function isLinkedInteraction(
  remembered: RememberedIngress,
): remembered is RememberedLinkedInteraction {
  return (
    remembered.ingress.identityContext.trigger === "interaction" &&
    remembered.ingress.identityResult.kind === "linked"
  );
}

function applicationUserId(ingress: SlackIngress): string | null {
  return ingress.identityResult.kind === "linked"
    ? ingress.identityResult.user.id
    : null;
}

function samePrincipal(left: SlackIngress, right: SlackIngress): boolean {
  return (
    left.identityContext.provider === right.identityContext.provider &&
    left.identityContext.tenant.id === right.identityContext.tenant.id &&
    left.identityContext.installation.id ===
      right.identityContext.installation.id &&
    left.identityContext.conversation.id ===
      right.identityContext.conversation.id &&
    providerThreadIdFromIdentity(left.identityContext) ===
      providerThreadIdFromIdentity(right.identityContext) &&
    left.identityContext.actor.id === right.identityContext.actor.id &&
    applicationUserId(left) === applicationUserId(right)
  );
}

function matchesSelector(
  ingress: SlackIngress,
  selector: SlackIngressSelector,
): boolean {
  const context = ingress.identityContext;
  return (
    context.provider === selector.provider &&
    context.actor.id === selector.providerActorId &&
    applicationUserId(ingress) === selector.applicationUserId
  );
}
