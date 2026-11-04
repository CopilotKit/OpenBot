/**
 * Where people can be reached outside OpenBot: their delivery bindings (a conversation with a Bot
 * bound to Slack, Teams or SMS) and their push devices. Both live in Intelligence's delivery
 * bindings capability (its `docs/contracts/delivery-bindings.md`); every instance holds all of them
 * in memory, kept fresh the way the Bot directory is.
 *
 * WHY ALL OF THEM. A binding is read on every inbound chat message (which person and conversation an
 * identity reaches) and a person's devices on every push. A deployment's bindings and devices number
 * in the people times their chat apps, not the millions, so each instance holds the whole set and
 * never puts a round trip under those reads.
 *
 * HOW IT STAYS FRESH. A write here keeps Intelligence's answer at once; other instances hear of it
 * from the realtime gateway (`delivery_changed`, by id and version) and read that one record. The
 * whole set is read again on every join of the subscription and on a timer, since an announcement
 * can be lost. An older copy never replaces a newer one.
 *
 * The queues of messages in flight (`delivery_inbox`, `delivery_outbox`) and pairing codes
 * (`delivery_challenges`) are not here: they are this deployment's operational state, kept in its
 * own database next to the work queue that runs them.
 */
import {
  createIntelligenceHttp,
  encode,
  IntelligenceApiError,
  type IntelligenceApiSettings,
  refused,
  writeKey,
} from "../conversations/http";
import {
  type ProjectChangeSubscription,
  subscribeToProjectChanges,
} from "../conversations/project-events";
import type { ImportResult } from "../conversations/types";
import {
  type BindingTransport,
  type DeliveryBinding,
  DeliveryRefusedError,
  type PushDevice,
} from "./types";

/** A binding as this deployment holds it: the delivery row's names, with Intelligence's state. */
export type StoredBinding = DeliveryBinding & {
  createdAt: Date;
  optedOutAt: Date | null;
  mentionId: string | null;
  version: number;
};

export type StoredDevice = PushDevice & { createdAt: Date; version: number };

type WireBinding = {
  id: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  userId: string;
  conversationId: string;
  agentId: string;
  threadId: string;
  transport: BindingTransport | "email";
  realm: string;
  identity: string;
  address: string;
  mentionId: string | null;
  enabled: boolean;
  optedOutAt: string | null;
};

type WireDevice = {
  id: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  userId: string;
  token: string;
  pushProjectId: string;
  platform: "ios" | "android";
  enabled: boolean;
};

function bindingFromWire(wire: WireBinding): StoredBinding {
  return {
    id: wire.id,
    ownerUserId: wire.userId,
    channelId: wire.conversationId,
    agentId: wire.agentId,
    threadId: wire.threadId,
    transport: wire.transport as BindingTransport,
    realm: wire.realm,
    identity: wire.identity,
    address: wire.address,
    mentionId: wire.mentionId,
    enabled: wire.enabled,
    optedOutAt: wire.optedOutAt ? new Date(wire.optedOutAt) : null,
    createdAt: new Date(wire.createdAt),
    version: wire.version,
  };
}

function deviceFromWire(wire: WireDevice): StoredDevice {
  return {
    id: wire.id,
    ownerUserId: wire.userId,
    token: wire.token,
    projectId: wire.pushProjectId,
    platform: wire.platform,
    enabled: wire.enabled,
    createdAt: new Date(wire.createdAt),
    version: wire.version,
  };
}

export function bindingToWire(
  binding: Omit<DeliveryBinding, "enabled"> & {
    enabled?: boolean;
    createdAt?: Date;
    optedOutAt?: Date | null;
  },
) {
  return {
    id: binding.id,
    userId: binding.ownerUserId,
    conversationId: binding.channelId,
    agentId: binding.agentId,
    threadId: binding.threadId,
    transport: binding.transport,
    realm: binding.realm,
    identity: binding.identity,
    address: binding.address,
    mentionId: binding.mentionId ?? null,
    ...(binding.enabled === undefined ? {} : { enabled: binding.enabled }),
    ...(binding.createdAt
      ? { createdAt: binding.createdAt.toISOString() }
      : {}),
    ...(binding.optedOutAt
      ? { optedOutAt: binding.optedOutAt.toISOString() }
      : {}),
  };
}

export function deviceToWire(
  device: Omit<PushDevice, "enabled"> & {
    enabled?: boolean;
    createdAt?: Date;
  },
) {
  return {
    id: device.id,
    userId: device.ownerUserId,
    token: device.token,
    pushProjectId: device.projectId,
    platform: device.platform,
    ...(device.enabled === undefined ? {} : { enabled: device.enabled }),
    ...(device.createdAt ? { createdAt: device.createdAt.toISOString() } : {}),
  };
}

export type DeliveryChange = {
  resource: "binding" | "push_device";
  id: string;
  version: number;
  change: "created" | "updated" | "purged";
};

function parseDeliveryChange(payload: unknown): DeliveryChange | null {
  if (!payload || typeof payload !== "object") return null;
  const { resource, id, version, change } = payload as Record<string, unknown>;
  if (resource !== "binding" && resource !== "push_device") return null;
  if (typeof id !== "string" || typeof version !== "number") return null;
  if (change !== "created" && change !== "updated" && change !== "purged")
    return null;
  return { resource, id, version, change };
}

export type DeliveryBindingsClient = ReturnType<
  typeof createDeliveryBindingsClient
>;

export function createDeliveryBindingsClient(
  settings: IntelligenceApiSettings,
) {
  const request = createIntelligenceHttp(settings);
  const client = {
    async bind(
      binding: Omit<DeliveryBinding, "enabled">,
      key: string,
    ): Promise<StoredBinding> {
      const response = await request("POST", "/api/delivery-bindings", {
        body: bindingToWire(binding),
        idempotencyKey: key,
      });
      if (response.status === 409)
        throw new DeliveryRefusedError(
          "That identity is already connected to another person.",
        );
      if (response.status !== 200 && response.status !== 201)
        return refused(response, "bind a delivery identity");
      return bindingFromWire((await response.json()) as WireBinding);
    },
    async getBinding(id: string): Promise<StoredBinding | null> {
      const response = await request(
        "GET",
        `/api/delivery-bindings/${encode(id)}`,
      );
      if (response.status === 404) return null;
      if (response.status !== 200)
        return refused(response, `read delivery binding ${id}`);
      return bindingFromWire((await response.json()) as WireBinding);
    },
    async changeBinding(
      id: string,
      body: { enabled?: boolean; optedOut?: boolean },
      key: string,
    ): Promise<StoredBinding | null> {
      const response = await request(
        "PATCH",
        `/api/delivery-bindings/${encode(id)}`,
        { body, idempotencyKey: key },
      );
      if (response.status === 404) return null;
      if (response.status !== 200)
        return refused(response, `change delivery binding ${id}`);
      return bindingFromWire((await response.json()) as WireBinding);
    },
    async allBindings(): Promise<{
      bindings: StoredBinding[];
      joinCode: string | null;
    }> {
      const bindings: StoredBinding[] = [];
      let cursor: string | null = null;
      let joinCode: string | null = null;
      do {
        const query = new URLSearchParams({ limit: "200" });
        if (cursor) query.set("cursor", cursor);
        const response = await request(
          "GET",
          `/api/delivery-bindings?${query}`,
        );
        if (response.status !== 200)
          return refused(response, "list delivery bindings");
        const body = (await response.json()) as {
          bindings: WireBinding[];
          nextCursor: string | null;
          joinCode?: string | null;
        };
        bindings.push(...body.bindings.map(bindingFromWire));
        joinCode = body.joinCode ?? joinCode;
        cursor = body.nextCursor;
      } while (cursor);
      return { bindings, joinCode };
    },
    async importBindings(
      items: ReturnType<typeof bindingToWire>[],
      key: string,
    ): Promise<ImportResult[]> {
      const response = await request("POST", "/api/delivery-bindings/import", {
        body: { bindings: items },
        idempotencyKey: key,
      });
      if (response.status !== 200)
        return refused(response, "import delivery bindings");
      return ((await response.json()) as { results: ImportResult[] }).results;
    },
    async purgeAgent(agentId: string, key: string): Promise<void> {
      const response = await request(
        "POST",
        "/api/delivery-bindings/purge-agent",
        { body: { agentId }, idempotencyKey: key },
      );
      if (response.status !== 200)
        return refused(response, `forget Bot ${agentId} in delivery bindings`);
    },
    async register(
      device: Omit<PushDevice, "enabled">,
      key: string,
    ): Promise<StoredDevice> {
      const response = await request("POST", "/api/push-devices", {
        body: deviceToWire(device),
        idempotencyKey: key,
      });
      if (response.status === 409)
        throw new DeliveryRefusedError(
          "This device is already registered to another account. Sign out of OpenBot on it first.",
        );
      if (response.status !== 200 && response.status !== 201)
        return refused(response, "register a push device");
      return deviceFromWire((await response.json()) as WireDevice);
    },
    async getDevice(id: string): Promise<StoredDevice | null> {
      const response = await request("GET", `/api/push-devices/${encode(id)}`);
      if (response.status === 404) return null;
      if (response.status !== 200)
        return refused(response, `read push device ${id}`);
      return deviceFromWire((await response.json()) as WireDevice);
    },
    async changeDevice(
      id: string,
      body: { enabled: boolean },
      key: string,
    ): Promise<StoredDevice | null> {
      const response = await request(
        "PATCH",
        `/api/push-devices/${encode(id)}`,
        { body, idempotencyKey: key },
      );
      if (response.status === 404) return null;
      if (response.status !== 200)
        return refused(response, `change push device ${id}`);
      return deviceFromWire((await response.json()) as WireDevice);
    },
    async allDevices(): Promise<{
      devices: StoredDevice[];
      joinCode: string | null;
    }> {
      const devices: StoredDevice[] = [];
      let cursor: string | null = null;
      let joinCode: string | null = null;
      do {
        const query = new URLSearchParams({ limit: "200" });
        if (cursor) query.set("cursor", cursor);
        const response = await request("GET", `/api/push-devices?${query}`);
        if (response.status !== 200)
          return refused(response, "list push devices");
        const body = (await response.json()) as {
          devices: WireDevice[];
          nextCursor: string | null;
          joinCode?: string | null;
        };
        devices.push(...body.devices.map(deviceFromWire));
        joinCode = body.joinCode ?? joinCode;
        cursor = body.nextCursor;
      } while (cursor);
      return { devices, joinCode };
    },
    async importDevices(
      items: ReturnType<typeof deviceToWire>[],
      key: string,
    ): Promise<ImportResult[]> {
      const response = await request("POST", "/api/push-devices/import", {
        body: { devices: items },
        idempotencyKey: key,
      });
      if (response.status !== 200)
        return refused(response, "import push devices");
      return ((await response.json()) as { results: ImportResult[] }).results;
    },
    async subscribe(): Promise<{ joinToken: string; joinCode: string }> {
      const response = await request("POST", "/api/delivery/subscribe", {
        body: {},
      });
      if (response.status !== 200)
        return refused(response, "subscribe to delivery bindings");
      return (await response.json()) as { joinToken: string; joinCode: string };
    },
  };
  return client;
}

export type DeliveryDirectory = {
  start(): Promise<void>;
  stop(): void;
  bindings(): StoredBinding[];
  binding(id: string): Promise<StoredBinding | null>;
  devices(): StoredDevice[];
  device(id: string): Promise<StoredDevice | null>;
  bind(binding: Omit<DeliveryBinding, "enabled">): Promise<StoredBinding>;
  changeBinding(
    id: string,
    body: { enabled?: boolean; optedOut?: boolean },
  ): Promise<StoredBinding | null>;
  register(device: Omit<PushDevice, "enabled">): Promise<StoredDevice>;
  changeDevice(id: string, enabled: boolean): Promise<StoredDevice | null>;
  /** Forget a Bot gone for good: every binding that leads to it. */
  purgeAgent(agentId: string): Promise<void>;
  resync(): Promise<void>;
  client: DeliveryBindingsClient;
};

const RESYNC_INTERVAL_MS = 15 * 60 * 1_000;

export function createDeliveryDirectory(options: {
  client: DeliveryBindingsClient;
  gatewayWsUrl?: string;
  resyncIntervalMs?: number;
}): DeliveryDirectory {
  const { client } = options;
  const bindings = new Map<string, StoredBinding>();
  const devices = new Map<string, StoredDevice>();
  /** When each was last confirmed, so a full read can tell a removal from a newcomer. */
  const seenAt = new Map<string, number>();
  const gone = new Map<string, number>();
  let subscription: ProjectChangeSubscription | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let resyncing: Promise<void> | undefined;
  let resyncAgain = false;

  const keyOf = (resource: DeliveryChange["resource"], id: string) =>
    `${resource}:${id}`;

  function keep<T extends { id: string; version: number }>(
    held: Map<string, T>,
    resource: DeliveryChange["resource"],
    record: T,
    confirmedAt = Date.now(),
  ): T {
    const key = keyOf(resource, record.id);
    const removed = gone.get(key);
    if (removed !== undefined && removed > confirmedAt) return record;
    gone.delete(key);
    seenAt.set(key, Math.max(seenAt.get(key) ?? 0, confirmedAt));
    const current = held.get(record.id);
    if (current && current.version > record.version) return current;
    held.set(record.id, record);
    return record;
  }

  const drop = (resource: DeliveryChange["resource"], id: string) => {
    const key = keyOf(resource, id);
    (resource === "binding" ? bindings : devices).delete(id);
    seenAt.delete(key);
    gone.set(key, Date.now());
  };

  const readAll = async () => {
    const startedAt = Date.now();
    const [bound, registered] = await Promise.all([
      client.allBindings(),
      client.allDevices(),
    ]);
    for (const binding of bound.bindings)
      keep(bindings, "binding", binding, startedAt);
    for (const device of registered.devices)
      keep(devices, "push_device", device, startedAt);
    const listed = new Set([
      ...bound.bindings.map((binding) => keyOf("binding", binding.id)),
      ...registered.devices.map((device) => keyOf("push_device", device.id)),
    ]);
    for (const id of [...bindings.keys()])
      if (
        !listed.has(keyOf("binding", id)) &&
        (seenAt.get(keyOf("binding", id)) ?? 0) < startedAt
      )
        drop("binding", id);
    for (const id of [...devices.keys()])
      if (
        !listed.has(keyOf("push_device", id)) &&
        (seenAt.get(keyOf("push_device", id)) ?? 0) < startedAt
      )
        drop("push_device", id);
    const subscribed = subscription?.joinCode();
    const joinCode = bound.joinCode ?? registered.joinCode;
    if (subscribed && subscribed !== joinCode) subscription?.renew();
  };

  const resync = (): Promise<void> => {
    if (resyncing) {
      resyncAgain = true;
      return resyncing;
    }
    resyncing = (async () => {
      try {
        do {
          resyncAgain = false;
          await readAll();
        } while (resyncAgain);
      } finally {
        resyncing = undefined;
      }
    })();
    return resyncing;
  };

  const heard = async (change: DeliveryChange) => {
    try {
      if (change.resource === "binding") {
        const current = bindings.get(change.id);
        if (current && current.version >= change.version) return;
        const startedAt = Date.now();
        const read = await client.getBinding(change.id);
        if (read) keep(bindings, "binding", read, startedAt);
        else drop("binding", change.id);
      } else {
        const current = devices.get(change.id);
        if (current && current.version >= change.version) return;
        const startedAt = Date.now();
        const read = await client.getDevice(change.id);
        if (read) keep(devices, "push_device", read, startedAt);
        else drop("push_device", change.id);
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "delivery-change-read-failed",
          id: change.id,
          note: "The next full read picks the change up.",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const directory: DeliveryDirectory = {
    client,
    async start() {
      if (options.gatewayWsUrl) {
        subscription = subscribeToProjectChanges({
          name: "delivery",
          topic: "delivery",
          event: "delivery_changed",
          subscribe: () => client.subscribe(),
          gatewayWsUrl: options.gatewayWsUrl,
          parse: parseDeliveryChange,
          onChange: (change) => {
            void heard(change);
          },
          onJoined: () => {
            resync().catch((error: unknown) =>
              console.warn(
                JSON.stringify({
                  type: "delivery-resync-failed",
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
            );
          },
        });
      }
      await resync();
      timer = setInterval(() => {
        resync().catch((error: unknown) =>
          console.warn(
            JSON.stringify({
              type: "delivery-resync-failed",
              note: "Still serving the bindings this instance last read.",
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      }, options.resyncIntervalMs ?? RESYNC_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      subscription?.stop();
    },
    bindings: () => [...bindings.values()],
    async binding(id) {
      const held = bindings.get(id);
      if (held) return held;
      // Made on another instance a moment ago, before its announcement arrived here.
      const read = await client.getBinding(id);
      return read ? keep(bindings, "binding", read) : null;
    },
    devices: () => [...devices.values()],
    async device(id) {
      const held = devices.get(id);
      if (held) return held;
      const read = await client.getDevice(id);
      return read ? keep(devices, "push_device", read) : null;
    },
    async bind(binding) {
      return keep(
        bindings,
        "binding",
        await client.bind(binding, writeKey("delivery.bind")),
      );
    },
    async changeBinding(id, body) {
      const changed = await client.changeBinding(
        id,
        body,
        writeKey("delivery.binding"),
      );
      if (!changed) {
        drop("binding", id);
        return null;
      }
      return keep(bindings, "binding", changed);
    },
    async register(device) {
      const registered = await client.register(
        device,
        writeKey("delivery.device"),
      );
      // A token that moved from an older registration took that registration's place.
      for (const [id, held] of devices)
        if (held.token === registered.token && id !== registered.id)
          drop("push_device", id);
      return keep(devices, "push_device", registered);
    },
    async changeDevice(id, enabled) {
      const changed = await client.changeDevice(
        id,
        { enabled },
        writeKey("delivery.device"),
      );
      if (!changed) {
        drop("push_device", id);
        return null;
      }
      return keep(devices, "push_device", changed);
    },
    async purgeAgent(agentId) {
      await client.purgeAgent(agentId, writeKey("delivery.purge-agent"));
      for (const [id, binding] of bindings)
        if (binding.agentId === agentId) drop("binding", id);
    },
    resync,
  };
  return directory;
}

let installed: DeliveryDirectory | undefined;

export function installDeliveryDirectory(
  directory: DeliveryDirectory,
): DeliveryDirectory {
  installed = directory;
  return directory;
}

/** The delivery bindings and push devices, as this process holds them. */
export function deliveryDirectory(): DeliveryDirectory {
  if (!installed) {
    throw new Error(
      "No delivery directory is installed. The server installs one at boot (delivery/directory.ts); a test installs the one in tests/support/conversations.ts.",
    );
  }
  return installed;
}

export { IntelligenceApiError };
