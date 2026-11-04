/**
 * Event triggers: the registered, authenticated ways an outside event reaches one responsibility.
 *
 * Every kind ends in the same place: an ingress route verifies the sender with that vendor's own
 * signature scheme, applies the trigger's narrow filter, and hands `store.ingestEvent` an event that
 * names this trigger and its responsibility. The store records the event and its runs in
 * Intelligence and queues them through the outbox (`store.ts`); the engine then runs the selected Bot
 * through the normal headless AG-UI path. There is no second engine and no second queue here.
 *
 * A trigger is a record in Intelligence's agent schedules (`responsibility-triggers`). Its secret
 * stays in this deployment's vault and the record names it by `credentialRef`, never holding it. An
 * inbound delivery finds its trigger in this instance's schedule directory (reading through on a
 * miss); the store re-checks it against Intelligence before anything is recorded.
 *
 * Paused and completed responsibilities never run: ingress refuses to queue for them, and
 * `beginRun` re-checks at dispatch and marks any run that slipped through as skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type CredentialSecretReader,
  type CredentialStore,
  decryptSecret,
  encryptSecret,
} from "../credentials";
import type { Database } from "../db/client";
import { ScheduleVersionConflictError } from "../schedules/client";
import { schedules } from "../schedules/directory";
import type {
  ResponsibilityRecord,
  ResponsibilityTriggerRecord,
  ScheduleChanges,
} from "../schedules/types";
import { withLocalLock } from "../work/local-lock";
import {
  ResponsibilityNotFoundError,
  ResponsibilityRefusedError,
  type ResponsibilitySource,
  type ResponsibilityStatus,
} from "./types";

export const triggerKinds = [
  "webhook",
  "github",
  "linear",
  "sentry",
  "pagerduty",
  "email",
  "slack",
] as const;
export type TriggerKind = (typeof triggerKinds)[number];

/** Kinds whose secret OpenBot generates; the others' secret is pasted from the vendor. */
const GENERATED_SECRET: ReadonlySet<TriggerKind> = new Set([
  "webhook",
  "github",
]);
/** Kinds authenticated by a shared secret at all. */
const SECRET_KINDS: ReadonlySet<TriggerKind> = new Set([
  "webhook",
  "github",
  "linear",
  "sentry",
  "pagerduty",
]);

const shortText = (maximum: number) => z.string().trim().min(1).max(maximum);
export const triggerFilterSchema = z
  .object({
    /**
     * Event types that fire this trigger. Empty means every event this kind delivers. A pattern
     * matches the exact type or any sub-type: `issues` matches `issues.opened`.
     */
    eventTypes: z.array(shortText(128)).max(20).default([]),
    /** One optional payload field that must equal a value, e.g. `data.team.key` = `ENG`. */
    field: z
      .object({
        path: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){0,7}$/, {
            message: "Use a dotted field path such as data.team.key.",
          }),
        equals: shortText(256),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TriggerFilter = z.infer<typeof triggerFilterSchema>;

const slackMode = z.enum(["mention", "phrase", "reaction", "message"]);
export const triggerConfigSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("webhook"),
      filter: triggerFilterSchema.default({ eventTypes: [] }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("github"),
      /** Optional owner/name lock: deliveries for any other repository are refused. */
      repository: z
        .string()
        .trim()
        .regex(/^[\w.-]+\/[\w.-]+$/, {
          message: "Use the GitHub repository owner/name.",
        })
        .max(256)
        .optional(),
      filter: triggerFilterSchema.default({ eventTypes: [] }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("linear"),
      filter: triggerFilterSchema.default({ eventTypes: [] }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sentry"),
      filter: triggerFilterSchema.default({ eventTypes: [] }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pagerduty"),
      filter: triggerFilterSchema.default({ eventTypes: [] }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("email"),
      /**
       * Addresses (`ops@example.com`) or domains (`example.com`) allowed to trigger. Empty admits any
       * sender. When set, SES must also report DMARC or DKIM as PASS, so a forged From is refused: SES
       * reports DKIM as GRAY, not PASS, when the signing domain does not match the From domain.
       */
      allowedSenders: z.array(shortText(254)).max(20).default([]),
      filter: triggerFilterSchema.default({ eventTypes: [] }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("slack"),
      /** The Slack workspace (T…) the paired Bot receives events from. */
      teamId: z
        .string()
        .trim()
        .regex(/^[A-Z0-9]{2,32}$/, {
          message: "Use the Slack team ID, e.g. T0123ABCD.",
        }),
      mode: slackMode,
      /** Mode `phrase`: case-insensitive substrings; any one matches. */
      phrases: z.array(shortText(200)).max(20).default([]),
      /** Mode `reaction`: emoji names without colons. Empty means any reaction. */
      reactions: z
        .array(
          z
            .string()
            .trim()
            .regex(/^[a-z0-9_+'-]{1,100}$/),
        )
        .max(20)
        .default([]),
      /** Slack channel IDs. Empty means every channel the Bot is in. */
      channels: z
        .array(
          z
            .string()
            .trim()
            .regex(/^[CDG][A-Z0-9]{2,32}$/),
        )
        .max(50)
        .default([]),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.mode === "phrase" && value.phrases.length === 0)
        context.addIssue({
          code: "custom",
          message: "Give at least one phrase to listen for.",
        });
    }),
]);
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

export function parseTriggerConfig(input: unknown): TriggerConfig {
  const result = triggerConfigSchema.safeParse(input);
  if (!result.success)
    throw new ResponsibilityRefusedError(
      result.error.issues[0]?.message ?? "Invalid trigger.",
    );
  return result.data;
}

export function sourceForKind(kind: TriggerKind): ResponsibilitySource {
  return kind;
}

function valueAt(payload: unknown, path: string): unknown {
  let value: unknown = payload;
  for (const segment of path.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

/** The narrow matching rule: event type (exact or sub-type) plus one optional field equality. */
export function matchesFilter(
  filter: TriggerFilter,
  eventType: string,
  payload: unknown,
): boolean {
  const type = eventType.toLowerCase();
  if (
    filter.eventTypes.length > 0 &&
    !filter.eventTypes.some((pattern) => {
      const wanted = pattern.toLowerCase();
      return wanted === "*" || type === wanted || type.startsWith(`${wanted}.`);
    })
  )
    return false;
  if (filter.field) {
    const actual = valueAt(payload, filter.field.path);
    if (
      actual === undefined ||
      actual === null ||
      typeof actual === "object" ||
      String(actual).toLowerCase() !== filter.field.equals.toLowerCase()
    )
      return false;
  }
  return true;
}

export const MAX_EVENT_PAYLOAD = 32_768;
/**
 * Provider payloads are often larger than the ledger's 32 KiB cap (a Sentry alert carries the whole
 * event). The top-level scalars survive intact and the rest is kept as a bounded excerpt, so the
 * Bot still sees what happened and the ledger stays bounded.
 */
export function fitPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const whole = JSON.stringify(payload);
  if (whole.length <= MAX_EVENT_PAYLOAD) return payload;
  // The scalars get half the cap. Uncapped, forty 1000-character fields filled it alone, the
  // excerpt below could not shrink past "", and the loop that trims it never ended.
  const scalars: Record<string, unknown> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(payload))
    if (
      value === null ||
      ["string", "number", "boolean"].includes(typeof value)
    ) {
      const scalar = typeof value === "string" ? value.slice(0, 1000) : value;
      const size = JSON.stringify({ [key]: scalar }).length;
      if (kept + size > MAX_EVENT_PAYLOAD / 2) continue;
      scalars[key] = scalar;
      kept += size;
    }
  const fitted: Record<string, unknown> = {
    truncated: true,
    ...scalars,
    excerpt: "",
  };
  const room = MAX_EVENT_PAYLOAD - JSON.stringify(fitted).length - 64;
  fitted.excerpt = Array.from(whole).slice(0, Math.max(0, room)).join("");
  while (JSON.stringify(fitted).length > MAX_EVENT_PAYLOAD)
    fitted.excerpt = String(fitted.excerpt).slice(0, -1024);
  return fitted;
}

/** `whsec_` + base64: usable as a bearer token and, decoded, as a Standard Webhooks HMAC key. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

export type TriggerRecord = {
  id: string;
  responsibilityId: string;
  kind: TriggerKind;
  config: TriggerConfig;
  hasSecret: boolean;
  /** A paused trigger acknowledges deliveries but never queues a run. */
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};
/** What an ingress route needs: the owner, target, config, lifecycle and the plaintext secret. */
export type ResolvedTrigger = {
  id: string;
  ownerUserId: string;
  responsibilityId: string;
  responsibilityStatus: ResponsibilityStatus;
  kind: TriggerKind;
  config: TriggerConfig;
  secret: string | null;
  enabled: boolean;
  createdAt: Date;
};

/**
 * Who may point a Bot at Slack. A Slack trigger feeds other people's messages into a run, so only
 * the responsibility's owner may create one (enforced by ownership), only in a workspace where that
 * owner has linked their own Slack identity, and only for channels that identity is a member of.
 * Checked when the trigger is saved and again for every event, so unlinking or leaving a channel
 * stops delivery. Supplied by the Slack pairing; absent means Slack triggers are refused.
 */
export type SlackAccess = {
  /** The owner's linked Slack user id in that workspace, or null when not linked. */
  linkedIdentity(ownerUserId: string, teamId: string): Promise<string | null>;
  /** Null when this deployment cannot check Slack channel membership yet (fail closed). */
  isMember:
    | ((input: {
        teamId: string;
        slackUserId: string;
        channelId: string;
      }) => Promise<boolean>)
    | null;
};
export async function slackAccessAllows(
  access: SlackAccess | undefined,
  ownerUserId: string,
  teamId: string,
  channelIds: string[],
): Promise<string | null> {
  if (!access)
    return "Slack triggers are not available on this deployment: the Slack pairing is not connected.";
  const slackUserId = await access.linkedIdentity(ownerUserId, teamId);
  if (!slackUserId)
    return "Link your own Slack account in that workspace first (the Bot's Reaching you page in OpenBot), so the trigger only hears channels you are in.";
  if (!access.isMember)
    return "Slack channel membership cannot be checked on this deployment yet, so Slack triggers are refused.";
  for (const channelId of channelIds)
    if (!(await access.isMember({ teamId, slackUserId, channelId })))
      return `You are not a member of Slack channel ${channelId}, so a trigger cannot listen there.`;
  return null;
}
export type TriggerDirectory = {
  resolve(id: string): Promise<ResolvedTrigger | null>;
  /** Slack listeners for one workspace, with their responsibility's Bot. */
  slackTriggers(
    teamId: string,
  ): Promise<(ResolvedTrigger & { agentId: string })[]>;
};

/** How often a write is redone after Intelligence says the trigger changed under it. */
const VERSION_RETRIES = 5;

const record = (trigger: ResponsibilityTriggerRecord): TriggerRecord => ({
  id: trigger.id,
  responsibilityId: trigger.responsibilityId,
  kind: trigger.kind,
  config: trigger.config as TriggerConfig,
  hasSecret: trigger.credentialRef !== null,
  enabled: trigger.enabled,
  createdAt: trigger.createdAt,
  updatedAt: trigger.updatedAt,
});

const live = <T extends { deletedAt: Date | null }>(
  value: T | null | undefined,
): value is T => !!value && value.deletedAt === null;

export function createTriggerStore(
  database: Database,
  vault: {
    store: CredentialStore;
    reader: CredentialSecretReader;
    encryptionKey: string;
  },
  options: { slackAccess?: () => SlackAccess | undefined } = {},
) {
  async function checkSlack(ownerUserId: string, config: TriggerConfig) {
    if (config.kind !== "slack") return;
    const refusal = await slackAccessAllows(
      options.slackAccess?.(),
      ownerUserId,
      config.teamId,
      config.channels,
    );
    if (refusal) throw new ResponsibilityRefusedError(refusal);
  }
  /** The person's own responsibility, as Intelligence holds it now. */
  async function ownedGoal(ownerUserId: string, responsibilityId: string) {
    const goal = await schedules().refresh(
      "responsibilities",
      responsibilityId,
    );
    if (!live(goal) || goal.ownerUserId !== ownerUserId)
      throw new ResponsibilityNotFoundError();
    return goal;
  }
  /** The person's own trigger, as Intelligence holds it now. Anybody else's does not exist. */
  async function ownedTrigger(ownerUserId: string, id: string) {
    const trigger = await schedules().refresh("responsibility-triggers", id);
    if (!live(trigger) || trigger.ownerUserId !== ownerUserId)
      throw new ResponsibilityNotFoundError();
    return trigger;
  }
  /** Apply changes derived from the trigger as it is now, again if it changed in between. */
  async function rewrite(
    ownerUserId: string,
    id: string,
    derive: (
      existing: ResponsibilityTriggerRecord,
    ) => Promise<ScheduleChanges<"responsibility-triggers">>,
  ) {
    for (let attempt = 1; ; attempt++) {
      const existing = await ownedTrigger(ownerUserId, id);
      const changes = await derive(existing);
      try {
        return await schedules().update(
          "responsibility-triggers",
          id,
          existing.version,
          changes,
        );
      } catch (error) {
        if (
          error instanceof ScheduleVersionConflictError &&
          attempt < VERSION_RETRIES
        )
          continue;
        throw error;
      }
    }
  }
  function checkSecret(secret: string) {
    if (!secret.trim() || secret.length > 4096)
      throw new ResponsibilityRefusedError(
        "Supply a secret of 1–4096 characters.",
      );
    return secret.trim();
  }
  async function secretFor(credentialRef: string | null) {
    if (!credentialRef) return null;
    const credential = await vault.reader.readSecret(credentialRef);
    if (!credential || credential.revokedAt) return null;
    return decryptSecret(vault.encryptionKey, credential.encryptedValue);
  }
  async function resolved(
    trigger: ResponsibilityTriggerRecord,
    goal: ResponsibilityRecord,
  ): Promise<ResolvedTrigger> {
    return {
      id: trigger.id,
      ownerUserId: trigger.ownerUserId,
      responsibilityId: trigger.responsibilityId,
      responsibilityStatus: goal.status,
      kind: trigger.kind,
      config: trigger.config as TriggerConfig,
      secret: await secretFor(trigger.credentialRef),
      enabled: trigger.enabled,
      createdAt: trigger.createdAt,
    };
  }

  return {
    async list(
      ownerUserId: string,
      responsibilityId: string,
    ): Promise<TriggerRecord[]> {
      await ownedGoal(ownerUserId, responsibilityId);
      const { items } = await schedules().client.all(
        "responsibility-triggers",
        { ownerUserId, responsibilityId },
      );
      return items.map(record);
    },
    /** Returns the secret once when OpenBot generated it; vendor secrets are pasted in `input.secret`. */
    async create(
      ownerUserId: string,
      responsibilityId: string,
      input: { config: unknown; secret?: string },
    ): Promise<{ trigger: TriggerRecord; secret: string | null }> {
      const config = parseTriggerConfig(input.config);
      await ownedGoal(ownerUserId, responsibilityId);
      await checkSlack(ownerUserId, config);
      const id = randomUUID();
      const secret = GENERATED_SECRET.has(config.kind)
        ? generateWebhookSecret()
        : SECRET_KINDS.has(config.kind) && input.secret
          ? checkSecret(input.secret)
          : null;
      // The secret first, then the trigger naming it; refused, the secret goes again rather than
      // outliving a trigger that is not there.
      const credential = secret
        ? await vault.store.create({
            kind: "connector",
            provider: `${config.kind}-trigger`,
            keyId: id,
            metadata: { ownerUserId, responsibilityId },
            encryptedValue: await encryptSecret(vault.encryptionKey, secret),
          })
        : null;
      let trigger: ResponsibilityTriggerRecord;
      try {
        trigger = await schedules().create(
          "responsibility-triggers",
          {
            id,
            ownerUserId,
            responsibilityId,
            kind: config.kind,
            config: config as unknown as Record<string, unknown>,
            credentialRef: credential?.id ?? null,
            enabled: true,
          },
          `openbot:trigger:${id}`,
        );
      } catch (error) {
        if (credential)
          await vault.store.revoke(credential.id).catch(() => undefined);
        throw error;
      }
      return {
        trigger: record(trigger),
        secret: GENERATED_SECRET.has(config.kind) ? secret : null,
      };
    },
    async update(ownerUserId: string, id: string, input: { config: unknown }) {
      const config = parseTriggerConfig(input.config);
      let checked = false;
      const trigger = await rewrite(ownerUserId, id, async (existing) => {
        if (config.kind !== existing.kind)
          throw new ResponsibilityRefusedError(
            "A trigger cannot change kind. Add a new trigger.",
          );
        if (!checked) await checkSlack(ownerUserId, config);
        checked = true;
        return { config: config as unknown as Record<string, unknown> };
      });
      return record(trigger);
    },
    async setEnabled(ownerUserId: string, id: string, enabled: boolean) {
      return record(await rewrite(ownerUserId, id, async () => ({ enabled })));
    },
    /** Every trigger on this owner's responsibilities carried out by one Bot (the chat tools' view). */
    async listForAgent(ownerUserId: string, agentId: string) {
      const [{ items: goals }, { items: triggers }] = await Promise.all([
        schedules().client.all("responsibilities", { ownerUserId, agentId }),
        schedules().client.all("responsibility-triggers", { ownerUserId }),
      ]);
      const titles = new Map(goals.map((goal) => [goal.id, goal.title]));
      return triggers.flatMap((trigger) => {
        const title = titles.get(trigger.responsibilityId);
        return title === undefined ? [] : [{ ...record(trigger), title }];
      });
    },
    /**
     * Rotate: a new generated secret for webhook/GitHub, or the vendor's new pasted secret for
     * Linear/Sentry/PagerDuty. The vault swaps the old credential for the new one in one step; the
     * trigger then names the new one.
     */
    async setSecret(
      ownerUserId: string,
      id: string,
      pasted?: string,
    ): Promise<{ trigger: TriggerRecord; secret: string | null }> {
      const existing = await ownedTrigger(ownerUserId, id);
      if (!SECRET_KINDS.has(existing.kind))
        throw new ResponsibilityRefusedError(
          "This trigger has no secret to rotate.",
        );
      const generated = GENERATED_SECRET.has(existing.kind);
      if (!generated && !pasted)
        throw new ResponsibilityRefusedError(
          "Paste the signing secret from the provider.",
        );
      const secret = generated
        ? generateWebhookSecret()
        : checkSecret(pasted ?? "");
      const encryptedValue = await encryptSecret(vault.encryptionKey, secret);
      return withLocalLock(
        database,
        `responsibility-trigger:${id}`,
        async () => {
          const value = {
            kind: "connector" as const,
            provider: `${existing.kind}-trigger`,
            keyId: id,
            metadata: {
              ownerUserId,
              responsibilityId: existing.responsibilityId,
            },
            encryptedValue,
          };
          /*
           * Rotated from the key's live credential, which is the one the trigger names, or, when a
           * rotation stopped after the vault and before the trigger, the one it left behind: so a second
           * attempt always finishes the first.
           */
          const previous = await vault.store.findLiveByKey(value);
          const credential = previous
            ? await vault.store.rotate({
                ...value,
                previousCredentialId: previous.id,
              })
            : await vault.store.create(value);
          const trigger = await rewrite(ownerUserId, id, async () => ({
            credentialRef: credential.id,
          }));
          return {
            trigger: record(trigger),
            secret: generated ? secret : null,
          };
        },
      );
    },
    /** The owner re-reading a generated secret (the page's copy button). Vendor secrets are never echoed. */
    async revealSecret(ownerUserId: string, id: string): Promise<string> {
      const existing = await ownedTrigger(ownerUserId, id);
      if (!GENERATED_SECRET.has(existing.kind))
        throw new ResponsibilityRefusedError(
          "Provider secrets are not shown again. Paste a new one to rotate.",
        );
      const secret = await secretFor(existing.credentialRef);
      if (!secret)
        throw new ResponsibilityRefusedError(
          "This trigger has no live secret. Rotate it.",
        );
      return secret;
    },
    async remove(ownerUserId: string, id: string) {
      await withLocalLock(
        database,
        `responsibility-trigger:${id}`,
        async () => {
          const trigger = await ownedTrigger(ownerUserId, id);
          // Deleted first, so its URL stops working at once; then its key is revoked.
          await schedules().remove("responsibility-triggers", id);
          if (trigger.credentialRef)
            await vault.store
              .revoke(trigger.credentialRef)
              .catch(async (error: unknown) => {
                // Already revoked is what was wanted; anything else is a key left live, said loudly.
                if (
                  await vault.store
                    .isLive(trigger.credentialRef ?? "")
                    .catch(() => true)
                )
                  throw error;
              });
        },
      );
    },
    directory: {
      async resolve(id: string) {
        if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
        const trigger = await schedules().find("responsibility-triggers", id);
        if (!live(trigger)) return null;
        const goal = await schedules().find(
          "responsibilities",
          trigger.responsibilityId,
        );
        return live(goal) ? resolved(trigger, goal) : null;
      },
      async slackTriggers(teamId: string) {
        // From memory: a Slack workspace's every message is asked here, and none of them waits on
        // Intelligence. The store re-checks a trigger against Intelligence before recording anything.
        const matching = schedules()
          .live("responsibility-triggers")
          .filter(
            (trigger) =>
              trigger.kind === "slack" &&
              (trigger.config as TriggerConfig).kind === "slack" &&
              (trigger.config as { teamId?: unknown }).teamId === teamId,
          );
        const found = await Promise.all(
          matching.map(async (trigger) => {
            const goal = await schedules().find(
              "responsibilities",
              trigger.responsibilityId,
            );
            return live(goal)
              ? [{ ...(await resolved(trigger, goal)), agentId: goal.agentId }]
              : [];
          }),
        );
        return found.flat();
      },
    } satisfies TriggerDirectory,
  };
}
export type TriggerStore = ReturnType<typeof createTriggerStore>;
