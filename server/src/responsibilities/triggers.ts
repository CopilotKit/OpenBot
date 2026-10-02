/**
 * Event triggers: the registered, authenticated ways an outside event reaches one responsibility.
 *
 * Every kind ends in the same place: an ingress route verifies the sender with that vendor's own
 * signature scheme, applies the trigger's narrow filter, and hands `store.ingestEvent` an event that
 * names this trigger and its responsibility. The store commits the event, the run ledger row and the
 * `work_items` queue entry in one transaction; the engine then runs the selected Bot through the
 * normal headless AG-UI path. There is no second engine and no second queue here.
 *
 * Paused and completed responsibilities never run: ingress refuses to queue for them, and
 * `beginRun` re-checks at dispatch and marks any run that slipped through as skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  type CredentialSecretReader,
  type CredentialStore,
  decryptSecret,
  encryptSecret,
} from "../credentials";
import type { Database } from "../db/client";
import {
  responsibilities,
  responsibilityTriggers,
} from "../db/schema/responsibilities";
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
  const scalars: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload))
    if (
      value === null ||
      ["string", "number", "boolean"].includes(typeof value)
    )
      scalars[key] = typeof value === "string" ? value.slice(0, 1000) : value;
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
    return "Link your own Slack account in that workspace first (Reachability), so the trigger only hears channels you are in.";
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
  const columns = {
    id: responsibilityTriggers.id,
    responsibilityId: responsibilityTriggers.responsibilityId,
    kind: responsibilityTriggers.kind,
    config: responsibilityTriggers.config,
    credentialId: responsibilityTriggers.credentialId,
    enabled: responsibilityTriggers.enabled,
    createdAt: responsibilityTriggers.createdAt,
    updatedAt: responsibilityTriggers.updatedAt,
  };
  type Row = {
    id: string;
    responsibilityId: string;
    kind: TriggerKind;
    config: TriggerConfig;
    credentialId: string | null;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  };
  const record = ({ credentialId, ...row }: Row): TriggerRecord => ({
    ...row,
    hasSecret: credentialId !== null,
  });
  async function ownedGoal(ownerUserId: string, responsibilityId: string) {
    const [goal] = await database
      .select({ id: responsibilities.id })
      .from(responsibilities)
      .where(
        and(
          eq(responsibilities.id, responsibilityId),
          eq(responsibilities.ownerUserId, ownerUserId),
        ),
      );
    if (!goal) throw new ResponsibilityNotFoundError();
  }
  async function ownedTrigger(ownerUserId: string, id: string) {
    const [row] = await database
      .select(columns)
      .from(responsibilityTriggers)
      .where(
        and(
          eq(responsibilityTriggers.id, id),
          eq(responsibilityTriggers.ownerUserId, ownerUserId),
        ),
      );
    if (!row) throw new ResponsibilityNotFoundError();
    return row;
  }
  function checkSecret(secret: string) {
    if (!secret.trim() || secret.length > 4096)
      throw new ResponsibilityRefusedError(
        "Supply a secret of 1–4096 characters.",
      );
    return secret.trim();
  }
  async function secretFor(credentialId: string | null) {
    if (!credentialId) return null;
    const credential = await vault.reader.readSecret(credentialId);
    if (!credential || credential.revokedAt) return null;
    return decryptSecret(vault.encryptionKey, credential.encryptedValue);
  }
  async function resolved(
    row: Row & { ownerUserId: string; status: ResponsibilityStatus },
  ) {
    return {
      id: row.id,
      ownerUserId: row.ownerUserId,
      responsibilityId: row.responsibilityId,
      responsibilityStatus: row.status,
      kind: row.kind,
      config: row.config,
      secret: await secretFor(row.credentialId),
      enabled: row.enabled,
      createdAt: row.createdAt,
    };
  }
  const resolvedColumns = {
    ...columns,
    ownerUserId: responsibilityTriggers.ownerUserId,
    status: responsibilities.status,
    agentId: responsibilities.agentId,
  };

  return {
    async list(
      ownerUserId: string,
      responsibilityId: string,
    ): Promise<TriggerRecord[]> {
      await ownedGoal(ownerUserId, responsibilityId);
      const rows = await database
        .select(columns)
        .from(responsibilityTriggers)
        .where(
          and(
            eq(responsibilityTriggers.ownerUserId, ownerUserId),
            eq(responsibilityTriggers.responsibilityId, responsibilityId),
          ),
        );
      return rows.map(record);
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
      return database.transaction(async (transaction) => {
        const credential = secret
          ? await vault.store.create(
              {
                kind: "connector",
                provider: `${config.kind}-trigger`,
                keyId: id,
                metadata: { ownerUserId, responsibilityId },
                encryptedValue: await encryptSecret(
                  vault.encryptionKey,
                  secret,
                ),
              },
              transaction,
            )
          : null;
        const [row] = await transaction
          .insert(responsibilityTriggers)
          .values({
            id,
            ownerUserId,
            responsibilityId,
            kind: config.kind,
            config,
            credentialId: credential?.id ?? null,
          })
          .returning(columns);
        if (!row) throw new Error("Trigger creation returned no row.");
        return {
          trigger: record(row),
          secret: GENERATED_SECRET.has(config.kind) ? secret : null,
        };
      });
    },
    async update(ownerUserId: string, id: string, input: { config: unknown }) {
      const existing = await ownedTrigger(ownerUserId, id);
      const config = parseTriggerConfig(input.config);
      if (config.kind !== existing.kind)
        throw new ResponsibilityRefusedError(
          "A trigger cannot change kind. Add a new trigger.",
        );
      await checkSlack(ownerUserId, config);
      const [row] = await database
        .update(responsibilityTriggers)
        .set({ config, updatedAt: new Date() })
        .where(eq(responsibilityTriggers.id, id))
        .returning(columns);
      if (!row) throw new ResponsibilityNotFoundError();
      return record(row);
    },
    async setEnabled(ownerUserId: string, id: string, enabled: boolean) {
      await ownedTrigger(ownerUserId, id);
      const [row] = await database
        .update(responsibilityTriggers)
        .set({ enabled, updatedAt: new Date() })
        .where(eq(responsibilityTriggers.id, id))
        .returning(columns);
      if (!row) throw new ResponsibilityNotFoundError();
      return record(row);
    },
    /** Every trigger on this owner's responsibilities carried out by one Bot (the chat tools' view). */
    async listForAgent(ownerUserId: string, agentId: string) {
      const rows = await database
        .select({ ...columns, title: responsibilities.title })
        .from(responsibilityTriggers)
        .innerJoin(
          responsibilities,
          eq(responsibilities.id, responsibilityTriggers.responsibilityId),
        )
        .where(
          and(
            eq(responsibilityTriggers.ownerUserId, ownerUserId),
            eq(responsibilities.agentId, agentId),
          ),
        );
      return rows.map(({ title, ...row }) => ({ ...record(row), title }));
    },
    /**
     * Rotate: a new generated secret for webhook/GitHub, or the vendor's new pasted secret for
     * Linear/Sentry/PagerDuty. The old credential is revoked in the same transaction.
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
      return database.transaction(async (transaction) => {
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
        const credential = existing.credentialId
          ? await vault.store.rotate(
              { ...value, previousCredentialId: existing.credentialId },
              transaction,
            )
          : await vault.store.create(value, transaction);
        const [row] = await transaction
          .update(responsibilityTriggers)
          .set({ credentialId: credential.id, updatedAt: new Date() })
          .where(eq(responsibilityTriggers.id, id))
          .returning(columns);
        if (!row) throw new ResponsibilityNotFoundError();
        return { trigger: record(row), secret: generated ? secret : null };
      });
    },
    /** The owner re-reading a generated secret (the page's copy button). Vendor secrets are never echoed. */
    async revealSecret(ownerUserId: string, id: string): Promise<string> {
      const existing = await ownedTrigger(ownerUserId, id);
      if (!GENERATED_SECRET.has(existing.kind))
        throw new ResponsibilityRefusedError(
          "Provider secrets are not shown again. Paste a new one to rotate.",
        );
      const secret = await secretFor(existing.credentialId);
      if (!secret)
        throw new ResponsibilityRefusedError(
          "This trigger has no live secret. Rotate it.",
        );
      return secret;
    },
    async remove(ownerUserId: string, id: string) {
      await database.transaction(async (transaction) => {
        const [row] = await transaction
          .select(columns)
          .from(responsibilityTriggers)
          .where(
            and(
              eq(responsibilityTriggers.id, id),
              eq(responsibilityTriggers.ownerUserId, ownerUserId),
            ),
          )
          .for("update");
        if (!row) throw new ResponsibilityNotFoundError();
        if (row.credentialId)
          await vault.store.revoke(row.credentialId, transaction);
        await transaction
          .delete(responsibilityTriggers)
          .where(eq(responsibilityTriggers.id, id));
      });
    },
    directory: {
      async resolve(id: string) {
        if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
        const [row] = await database
          .select(resolvedColumns)
          .from(responsibilityTriggers)
          .innerJoin(
            responsibilities,
            eq(responsibilities.id, responsibilityTriggers.responsibilityId),
          )
          .where(eq(responsibilityTriggers.id, id));
        return row ? resolved(row) : null;
      },
      async slackTriggers(teamId: string) {
        const rows = await database
          .select(resolvedColumns)
          .from(responsibilityTriggers)
          .innerJoin(
            responsibilities,
            eq(responsibilities.id, responsibilityTriggers.responsibilityId),
          )
          .where(eq(responsibilityTriggers.kind, "slack"));
        const matching = rows.filter(
          (row) => row.config.kind === "slack" && row.config.teamId === teamId,
        );
        return Promise.all(
          matching.map(async (row) => ({
            ...(await resolved(row)),
            agentId: row.agentId,
          })),
        );
      },
    } satisfies TriggerDirectory,
  };
}
export type TriggerStore = ReturnType<typeof createTriggerStore>;
