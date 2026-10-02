import { resolveUpdateRoute, type UpdateRoute } from "../agents/lifecycle";
import type { DrawnComponent } from "../routines/runner";
import type { WorkItem, WorkQueue } from "../work/queue";
import type { ExpoPushTransport } from "./push";
import type { DeliveryStore } from "./store";
import {
  type ChatTransport,
  type DeliveryBinding,
  DeliveryProviderError,
  DeliveryRefusedError,
  type DeliveryScope,
  type TextTransport,
} from "./types";
/** What a paired chat turn produced besides its reply, surfaced in that same turn. */
export type InlineTurnExtras = {
  approvals: string[];
  questions: { id: string; text: string }[];
};
export type ConverseResult =
  | { kind: "unbound" }
  | { kind: "duplicate"; binding: DeliveryBinding }
  | {
      kind: "replied" | "waiting";
      binding: DeliveryBinding;
      inboxId: string;
      replyText: string;
      /** Display components the turn drew, for a chat surface that can draw them natively. */
      components?: DrawnComponent[];
      extras: InlineTurnExtras;
      waiting?: { kind: string; requestId?: string; approvalId?: string };
    }
  | {
      kind: "failed";
      binding: DeliveryBinding;
      inboxId: string;
      message: string;
    };
/** Twilio error 21610: the recipient has opted out, so Twilio refuses the send. */
const TWILIO_UNSUBSCRIBED = "21610";
export type DeliveryWorkKind =
  | "delivery.inbound"
  | "delivery.outbound"
  | "delivery.push-receipt";
export const DELIVERY_WORK_KINDS: DeliveryWorkKind[] = [
  "delivery.inbound",
  "delivery.outbound",
  "delivery.push-receipt",
];
type RouterStore = Pick<
  DeliveryStore,
  | "findBinding"
  | "binding"
  | "bindingsFor"
  | "devices"
  | "device"
  | "removeDevice"
  | "offerInbox"
  | "inbox"
  | "setInbox"
  | "offerOutbox"
  | "outbox"
  | "startOutbox"
  | "setOutbox"
  | "offerReceipt"
  | "recordInbox"
  | "setSmsOptOut"
  | "botIdentity"
>;
export function createDeliveryRouter(deps: {
  store: RouterStore;
  queue: Pick<WorkQueue, "claim" | "renew" | "finish" | "release">;
  owner: string;
  authoriseScope(scope: DeliveryScope): Promise<boolean>;
  runTurn(
    input: DeliveryScope & { runId: string; text: string; signal: AbortSignal },
  ): Promise<{
    replyText: string;
    components?: DrawnComponent[];
    waiting?: boolean;
  }>;
  providers: {
    /** Slack and Teams both reach people through the OpenTag pairing's proactive delivery. */
    slack?: TextTransport;
    teams?: TextTransport;
    sms?: TextTransport;
    push?: ExpoPushTransport;
  };
  /** The person's routing by kind; defaults to the lifecycle lane's `resolveUpdateRoute`. */
  routeFor?(input: {
    ownerUserId: string;
    agentId: string;
    kind: "reply" | "question" | "approval";
  }): Promise<UpdateRoute>;
  /** Unused since Slack events feed `ingestSlackEvent` from the pairing route; kept for assembly. */
  notifyEvent?(event: {
    ownerUserId: string;
    source: "slack";
    externalId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<unknown>;
  audit?(event: {
    ownerUserId: string;
    channelId: string;
    id: string;
    kind: string;
    state: string;
  }): Promise<void>;
}) {
  const leaseMs = 60_000;
  /**
   * Bindings with a paired chat turn open in this process. An approval or question raised during
   * that turn is shown in the turn itself (an OpenTag card, or text), so it is collected here rather
   * than also sent as a second, proactive message to the same person.
   */
  const inline = new Map<string, InlineTurnExtras>();
  async function notify(
    scope: DeliveryScope,
    input: {
      id: string;
      text: string;
      kind: "reply" | "question" | "approval";
      requestId?: string | null;
    },
    includeBindings = true,
  ) {
    if (!(await deps.authoriseScope(scope)))
      throw new DeliveryRefusedError("Conversation access has been revoked.");
    // Progress/decision/question routing and the per-Bot notification preference. Fails open.
    const route = await (deps.routeFor ?? resolveUpdateRoute)({
      ownerUserId: scope.ownerUserId,
      agentId: scope.agentId,
      kind: input.kind,
    });
    if (includeBindings)
      for (const binding of await deps.store.bindingsFor(scope)) {
        const open = inline.get(binding.id);
        if (open && input.kind === "approval" && input.requestId) {
          open.approvals.push(input.requestId);
          continue;
        }
        if (open && input.kind === "question") {
          open.questions.push({
            id: input.requestId ?? input.id,
            text: input.text,
          });
          continue;
        }
        // Teams is a chat surface like Slack; routing names chat transports as `slack` until the
        // lifecycle lane lists `teams` separately.
        if (
          !route.allows(
            binding.transport === "teams" ? "slack" : binding.transport,
          )
        )
          continue;
        await deps.store.offerOutbox({
          ...scope,
          dedupeKey: `${input.kind}:${input.id}:binding:${binding.id}`,
          bindingId: binding.id,
          deviceId: null,
          transport: binding.transport,
          text: input.text,
          kind: input.kind,
          requestId: input.requestId ?? null,
        });
      }
    if (route.allows("push"))
      for (const device of await deps.store.devices(scope.ownerUserId))
        await deps.store.offerOutbox({
          ...scope,
          dedupeKey: `${input.kind}:${input.id}:device:${device.id}`,
          bindingId: null,
          deviceId: device.id,
          transport: "push",
          text: input.text,
          kind: input.kind,
          requestId: input.requestId ?? null,
        });
  }
  async function receive(input: {
    source: "sms";
    realm: string;
    identity: string;
    address?: string;
    externalId: string;
    text: string;
    echo?: boolean;
  }) {
    if (input.echo) return { queued: false };
    const binding = await deps.store.findBinding(
      input.source,
      input.realm,
      input.identity,
      input.address,
    );
    if (!binding || !(await deps.authoriseScope(binding)))
      return { queued: false };
    // Opted out by STOP: their texts start no turns until they send START.
    if (binding.optedOutAt) return { queued: false };
    const result = await deps.store.offerInbox({
      ownerUserId: binding.ownerUserId,
      channelId: binding.channelId,
      agentId: binding.agentId,
      threadId: binding.threadId,
      bindingId: binding.id,
      source: input.source,
      realm: input.realm,
      externalId: input.externalId,
      text: input.text,
    });
    // The downstream event engine deduplicates independently: a provider retry can recover an
    // interrupted event insertion without re-running the conversational turn.
    return result;
  }
  /**
   * One paired Slack/Teams message, run now and answered in the same AG-UI stream.
   *
   * The same canonical turn as every other delivery (`runTurn`: the owner's selected Bot, in the
   * bound Intelligence thread, with learning, governance, approvals and audit), recorded in the
   * inbox for dedupe and visibility but not queued, since the caller is waiting for the answer.
   */
  async function converse(input: {
    transport: ChatTransport;
    realm: string;
    identity: string;
    externalId: string;
    text: string;
    signal: AbortSignal;
  }): Promise<ConverseResult> {
    const binding = await deps.store.findBinding(
      input.transport,
      input.realm,
      input.identity,
    );
    if (!binding || !(await deps.authoriseScope(binding)))
      return { kind: "unbound" };
    const scope = {
      ownerUserId: binding.ownerUserId,
      channelId: binding.channelId,
      agentId: binding.agentId,
      threadId: binding.threadId,
    };
    const row = await deps.store.recordInbox({
      ...scope,
      bindingId: binding.id,
      source: input.transport,
      realm: input.realm,
      externalId: input.externalId,
      text: input.text,
    });
    if (!row) return { kind: "duplicate", binding };
    // Slack responsibilities are fed by the pairing route through `ingestSlackEvent`, once per
    // event, so the turn itself does not also emit one.
    const extras: InlineTurnExtras = { approvals: [], questions: [] };
    inline.set(binding.id, extras);
    try {
      const result = await deps.runTurn({
        ...scope,
        runId: row.id,
        text: input.text,
        signal: input.signal,
      });
      await deps.store.setInbox(row.id, "sent");
      await deps.audit?.({
        ...scope,
        id: row.id,
        kind: "inbound",
        state: "sent",
      });
      return {
        kind: extras.approvals.length || result.waiting ? "waiting" : "replied",
        binding,
        inboxId: row.id,
        replyText: result.replyText,
        ...(result.components?.length ? { components: result.components } : {}),
        extras,
      };
    } catch (error) {
      // The governed turn stopped for a person: a durable approval or hand-off is now pending.
      if (
        error instanceof Error &&
        error.name === "HeadlessToolSuspension" &&
        "waiting" in error &&
        error.waiting &&
        typeof error.waiting === "object"
      ) {
        const waiting = error.waiting as {
          kind: string;
          requestId?: string;
          approvalId?: string;
        };
        const pending = waiting.approvalId ?? waiting.requestId;
        if (
          waiting.kind === "approval" &&
          pending &&
          !extras.approvals.includes(pending)
        )
          extras.approvals.push(pending);
        await deps.store.setInbox(
          row.id,
          "accepted",
          "Waiting for a person's decision.",
        );
        return {
          kind: "waiting",
          binding,
          inboxId: row.id,
          replyText: "",
          extras,
          waiting,
        };
      }
      const message =
        error instanceof DeliveryRefusedError
          ? error.message
          : "The agent turn failed. Inspect the conversation before retrying.";
      await deps.store.setInbox(row.id, "failed", message);
      await deps.audit?.({
        ...scope,
        id: row.id,
        kind: "inbound",
        state: "failed",
      });
      return { kind: "failed", binding, inboxId: row.id, message };
    } finally {
      if (inline.get(binding.id) === extras) inline.delete(binding.id);
    }
  }
  async function deliver(
    item: WorkItem,
    signal: AbortSignal,
    owns: () => Promise<boolean>,
  ) {
    if (!(await owns())) return;
    if (item.kind === "delivery.inbound") {
      const row = await deps.store.inbox(item.key);
      if (
        !row ||
        row.state === "sent" ||
        row.state === "failed" ||
        row.state === "unknown"
      )
        return;
      if (row.state === "running") {
        await deps.store.setInbox(
          row.id,
          "unknown",
          "Previous agent turn stopped after execution began; inspect conversation before retrying.",
        );
        return;
      }
      if (!(await deps.authoriseScope(row))) {
        await deps.store.setInbox(
          row.id,
          "failed",
          "Conversation access has been revoked.",
        );
        return;
      }
      if (row.bindingId) {
        const binding = await deps.store.binding(row.bindingId);
        if (
          !binding?.enabled ||
          binding.ownerUserId !== row.ownerUserId ||
          binding.channelId !== row.channelId ||
          binding.agentId !== row.agentId ||
          binding.threadId !== row.threadId
        ) {
          await deps.store.setInbox(
            row.id,
            "failed",
            "The source connection changed or was disconnected.",
          );
          return;
        }
      }
      await deps.store.setInbox(row.id, "running");
      try {
        const result = await deps.runTurn({
          ownerUserId: row.ownerUserId,
          channelId: row.channelId,
          agentId: row.agentId,
          threadId: row.threadId,
          runId: row.id,
          text: row.text,
          signal,
        });
        if (!(await owns())) return;
        if (result.replyText)
          await notify(row, {
            id: row.id,
            text: result.replyText,
            kind: "reply",
          });
        await deps.store.setInbox(row.id, "sent");
        await deps.audit?.({
          ownerUserId: row.ownerUserId,
          channelId: row.channelId,
          id: row.id,
          kind: "inbound",
          state: "sent",
        });
      } catch (error) {
        if (!(await owns())) return;
        await deps.store.setInbox(
          row.id,
          "failed",
          error instanceof DeliveryRefusedError
            ? error.message
            : "The agent turn failed. Inspect the conversation before retrying.",
        );
        throw error;
      }
      return;
    }
    const current = await deps.store.outbox(item.key);
    if (!current) return;
    if (item.kind === "delivery.push-receipt") {
      if (
        current.transport !== "push" ||
        current.state !== "accepted" ||
        !current.providerId ||
        !deps.providers.push
      )
        return;
      const receipt = await deps.providers.push.receipt(current.providerId);
      if (!(await owns())) return;
      if (receipt.status === "pending") {
        await deps.store.setOutbox(
          current.id,
          "failed",
          "Expo did not provide a receipt after the receipt window.",
        );
        return;
      }
      await deps.store.setOutbox(
        current.id,
        receipt.status,
        receipt.error ?? null,
      );
      if (receipt.revokeDevice && current.deviceId)
        await deps.store.removeDevice(current.ownerUserId, current.deviceId);
      return;
    }
    if (current.state === "running") {
      await deps.store.setOutbox(
        current.id,
        "unknown",
        "Previous delivery stopped after sending began; inspect provider history before retrying.",
      );
      return;
    }
    if (current.state !== "queued") return;
    if (!(await deps.authoriseScope(current))) {
      await deps.store.setOutbox(
        current.id,
        "failed",
        "Conversation access has been revoked.",
      );
      return;
    }
    const row = await deps.store.startOutbox(current.id);
    if (!row || !(await owns())) return;
    try {
      let result: { id: string; status: "queued" | "sent" | "accepted" };
      if (row.transport === "push") {
        const device = row.deviceId
          ? await deps.store.device(row.deviceId)
          : null;
        if (
          !device?.enabled ||
          device.ownerUserId !== row.ownerUserId ||
          !deps.providers.push
        )
          throw new DeliveryRefusedError("Push device unavailable.");
        result = await deps.providers.push.send({
          token: device.token,
          title: "OpenBot",
          body: row.text,
          channelId: row.channelId,
          kind: row.kind,
          requestId: row.requestId,
        });
      } else {
        const binding = row.bindingId
          ? await deps.store.binding(row.bindingId)
          : null;
        if (
          !binding?.enabled ||
          binding.ownerUserId !== row.ownerUserId ||
          binding.channelId !== row.channelId ||
          binding.agentId !== row.agentId ||
          binding.threadId !== row.threadId
        )
          throw new DeliveryRefusedError(
            "Connection unavailable or moved to another conversation.",
          );
        if (row.transport === "sms" && binding.optedOutAt) {
          if (!(await owns())) return;
          await deps.store.setOutbox(
            row.id,
            "opted_out",
            "The recipient replied STOP. Nothing was sent; they can reply START to resume.",
          );
          return;
        }
        const provider = deps.providers[row.transport];
        if (!provider) throw new DeliveryRefusedError("Provider unavailable.");
        const sender =
          row.transport === "sms"
            ? undefined
            : ((await deps.store.botIdentity(row.agentId)) ?? undefined);
        result = await provider.send({
          id: row.id,
          address: binding.address,
          text: row.text,
          transport: row.transport,
          ...(sender ? { sender } : {}),
        });
      }
      if (!(await owns())) return;
      await deps.store.setOutbox(
        row.id,
        result.status === "queued" ? "accepted" : result.status,
        null,
        result.id,
      );
      if (row.transport === "push") await deps.store.offerReceipt(row.id);
      await deps.audit?.({
        ownerUserId: row.ownerUserId,
        channelId: row.channelId,
        id: row.id,
        kind: row.transport,
        state: result.status,
      });
    } catch (error) {
      if (!(await owns())) return;
      if (
        error instanceof DeliveryProviderError &&
        error.provider === "Twilio" &&
        error.code === TWILIO_UNSUBSCRIBED
      ) {
        const binding = row.bindingId
          ? await deps.store.binding(row.bindingId)
          : null;
        if (binding) await smsOptOut(binding.realm, binding.identity, true);
        await deps.store.setOutbox(
          row.id,
          "opted_out",
          "Twilio reports this number opted out (21610). Nothing was sent.",
        );
        return;
      }
      await deps.store.setOutbox(
        row.id,
        error instanceof DeliveryProviderError && error.uncertain
          ? "unknown"
          : "failed",
        error instanceof DeliveryRefusedError ||
          error instanceof DeliveryProviderError
          ? error.message
          : "Provider delivery failed.",
      );
      if (
        error instanceof DeliveryProviderError &&
        error.code === "DeviceNotRegistered" &&
        row.deviceId
      )
        await deps.store.removeDevice(row.ownerUserId, row.deviceId);
      await deps.audit?.({
        ownerUserId: row.ownerUserId,
        channelId: row.channelId,
        id: row.id,
        kind: row.transport,
        state: "failed",
      });
    }
  }
  /** Twilio STOP/START for one number: record it on every binding for that number, and audit it. */
  async function smsOptOut(realm: string, identity: string, optedOut: boolean) {
    const rows = await deps.store.setSmsOptOut(realm, identity, optedOut);
    for (const row of rows)
      await deps.audit?.({
        ownerUserId: row.ownerUserId,
        channelId: row.channelId,
        id: row.id,
        kind: "sms_opt_out",
        state: optedOut ? "opted_out" : "opted_in",
      });
    return rows.length;
  }
  return {
    receive,
    converse,
    notify,
    smsOptOut,
    async receiveNative(
      scope: DeliveryScope,
      text: string,
      externalId: string,
    ) {
      if (!(await deps.authoriseScope(scope)))
        throw new DeliveryRefusedError("Conversation unavailable.");
      return deps.store.offerInbox({
        ...scope,
        bindingId: null,
        source: "native",
        realm: scope.ownerUserId,
        externalId,
        text,
      });
    },
    async sweep(kind: DeliveryWorkKind) {
      for (const item of await deps.queue.claim({
        kind,
        owner: deps.owner,
        leaseMs,
        limit: 1,
        maxAttempts: 5,
      })) {
        const controller = new AbortController();
        let lost = false;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let heartbeat: Promise<void> = Promise.resolve();
        const owns = async () => {
          if (lost) return false;
          const held = await deps.queue.renew({
            kind,
            key: item.key,
            owner: deps.owner,
            leaseMs,
          });
          if (!held) {
            lost = true;
            controller.abort();
          }
          return held;
        };
        const schedule = () => {
          timer = setTimeout(() => {
            heartbeat = (async () => {
              try {
                if ((await owns()) && !stopped) schedule();
              } catch {
                console.error(
                  JSON.stringify({
                    type: "delivery-lease-renewal-failed",
                    kind,
                    id: item.key,
                  }),
                );
                lost = true;
                controller.abort();
              }
            })();
          }, leaseMs / 3);
          timer.unref?.();
        };
        schedule();
        try {
          await deliver(item, controller.signal, owns);
          if (!lost)
            await deps.queue.finish({ kind, key: item.key, owner: deps.owner });
        } catch (error) {
          if (!lost)
            await deps.queue.release({
              kind,
              key: item.key,
              owner: deps.owner,
              delayMs: 60_000,
              reason:
                error instanceof DeliveryProviderError
                  ? error.message
                  : "Delivery processing failed.",
            });
          throw error;
        } finally {
          stopped = true;
          if (timer) clearTimeout(timer);
          await heartbeat;
        }
      }
    },
  };
}
export type DeliveryRouter = ReturnType<typeof createDeliveryRouter>;
