/**
 * The standing work people set up for their Bots, and its history, as Intelligence's agent schedules
 * hold it (`docs/contracts/agent-schedules.md` in the Intelligence repo).
 *
 * Twelve collections, each one record type. The field names are Intelligence's, which follow the
 * names OpenBot's own tables had, so a store that used to read a row reads a record with the same
 * fields. Timestamps arrive as RFC 3339 strings and are `Date`s here (`client.ts` converts).
 */

/** What every record carries. `deletedAt` only on the collections that soft-delete. */
export type ScheduleRecordBase = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

type SoftDeleted = { deletedAt: Date | null };

export type RoutineRecord = ScheduleRecordBase &
  SoftDeleted & {
    ownerUserId: string;
    agentId: string;
    channelId: string;
    instruction: string;
    cron: string;
    timezone: string;
    enabled: boolean;
    enabledAt: Date;
    nextRunAt: Date;
    lastRunAt: Date | null;
  };

export type RoutineRunStatus = "succeeded" | "failed" | "skipped" | "waiting";

export type RoutineRunRecord = ScheduleRecordBase & {
  routineId: string;
  source: "schedule" | "run_now" | "trigger";
  /** Null while the firing is in flight. */
  status: RoutineRunStatus | null;
  startedAt: Date;
  finishedAt: Date | null;
  waiting: Record<string, unknown> | null;
  error: string | null;
};

export type CheckInSettingRecord = ScheduleRecordBase &
  SoftDeleted & {
    ownerUserId: string;
    agentId: string;
    channelId: string;
    threadId: string;
    focus: string;
    enabled: boolean;
    intervalMinutes: number;
    nextRunAt: Date;
    lastRunAt: Date | null;
    lastStatus: "idle" | "running" | "succeeded" | "error";
    lastError: string | null;
  };

export type CheckInRunOutcome =
  | "running"
  | "quiet"
  | "raised"
  | "failed"
  | "skipped";

export type CheckInSkipReason =
  | "off_admin"
  | "off_person"
  | "paused"
  | "capped"
  | "unreachable"
  | "no_sources"
  | "busy";

export type CheckInRunRecord = ScheduleRecordBase & {
  settingId: string;
  ownerUserId: string;
  agentId: string;
  threadId: string | null;
  trigger: "schedule" | "run_now";
  outcome: CheckInRunOutcome;
  skipReason: CheckInSkipReason | null;
  itemsRaised: number;
  reads: number;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
};

/** One person's hourly ping slot. The id is the person's id. */
export type CheckInPersonRecord = ScheduleRecordBase & {
  lastPingedAt: Date | null;
};

export type CheckInPingRecord = ScheduleRecordBase & {
  ownerUserId: string;
  itemCount: number;
  text: string;
  pushBody: string;
  offeredAt: Date | null;
};

export type CheckInSuggestionStatus =
  | "open"
  | "dismissed"
  | "started"
  | "superseded";

export type CheckInSuggestionRecord = ScheduleRecordBase & {
  ownerUserId: string;
  agentId: string;
  settingId: string;
  runId: string;
  title: string;
  detail: string;
  sourceApp: string | null;
  sourceRef: string | null;
  sourceLink: string | null;
  status: CheckInSuggestionStatus;
  dedupeKey: string | null;
  pingId: string | null;
  deliveredAt: Date | null;
  resolvedAt: Date | null;
};

export type ResponsibilityRecord = ScheduleRecordBase &
  SoftDeleted & {
    ownerUserId: string;
    agentId: string;
    channelId: string;
    threadId: string;
    title: string;
    instruction: string;
    successCriteria: string;
    status: "active" | "paused" | "completed";
    progress: string;
    lastResult: string | null;
    subscriptions: { source: string; eventType: string }[];
    completedAt: Date | null;
  };

export type ResponsibilityTriggerRecord = ScheduleRecordBase &
  SoftDeleted & {
    ownerUserId: string;
    responsibilityId: string;
    kind:
      | "webhook"
      | "github"
      | "linear"
      | "sentry"
      | "pagerduty"
      | "email"
      | "slack";
    config: Record<string, unknown>;
    /** A reference into OpenBot's vault (a credential id), never the secret. */
    credentialRef: string | null;
    enabled: boolean;
  };

export type ResponsibilitySourceBindingRecord = ScheduleRecordBase &
  SoftDeleted & {
    ownerUserId: string;
    source: "github";
    repository: string;
    credentialRef: string;
  };

export type ResponsibilityEventRecord = ScheduleRecordBase & {
  ownerUserId: string;
  source: string;
  externalId: string;
  type: string;
  payload: Record<string, unknown>;
};

export type ResponsibilityRunRecord = ScheduleRecordBase & {
  responsibilityId: string;
  eventId: string;
  status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "skipped";
  replyText: string | null;
  error: string | null;
  waiting: Record<string, unknown> | null;
  continuation: Record<string, unknown> | null;
  startedAt: Date | null;
  finishedAt: Date | null;
};

/** Every collection, by its name in the API, and the record it holds. */
export type ScheduleCollections = {
  routines: RoutineRecord;
  "routine-runs": RoutineRunRecord;
  "check-in-settings": CheckInSettingRecord;
  "check-in-runs": CheckInRunRecord;
  "check-in-people": CheckInPersonRecord;
  "check-in-pings": CheckInPingRecord;
  "check-in-suggestions": CheckInSuggestionRecord;
  responsibilities: ResponsibilityRecord;
  "responsibility-triggers": ResponsibilityTriggerRecord;
  "responsibility-source-bindings": ResponsibilitySourceBindingRecord;
  "responsibility-events": ResponsibilityEventRecord;
  "responsibility-runs": ResponsibilityRunRecord;
};

export type ScheduleCollection = keyof ScheduleCollections;

/**
 * The collections Intelligence announces changes to, which every server instance holds in memory
 * (`directory.ts`): the definitions a sweep or a turn reads, never the run history.
 */
export const ANNOUNCED_COLLECTIONS = [
  "routines",
  "check-in-settings",
  "check-in-people",
  "responsibilities",
  "responsibility-triggers",
  "responsibility-source-bindings",
] as const satisfies readonly ScheduleCollection[];

export type AnnouncedCollection = (typeof ANNOUNCED_COLLECTIONS)[number];

/** Fields of each collection that are timestamps on the wire, converted to and from `Date`. */
export const DATE_FIELDS: Record<ScheduleCollection, readonly string[]> = {
  routines: ["enabledAt", "nextRunAt", "lastRunAt", "deletedAt"],
  "routine-runs": ["startedAt", "finishedAt"],
  "check-in-settings": ["nextRunAt", "lastRunAt", "deletedAt"],
  "check-in-runs": ["startedAt", "finishedAt"],
  "check-in-people": ["lastPingedAt"],
  "check-in-pings": ["offeredAt"],
  "check-in-suggestions": ["deliveredAt", "resolvedAt"],
  responsibilities: ["completedAt", "deletedAt"],
  "responsibility-triggers": ["deletedAt"],
  "responsibility-source-bindings": ["deletedAt"],
  "responsibility-events": [],
  "responsibility-runs": ["startedAt", "finishedAt"],
};

/** What a create sends: the record without the fields Intelligence owns. */
export type ScheduleDraft<C extends ScheduleCollection> = Omit<
  ScheduleCollections[C],
  "createdAt" | "updatedAt" | "version" | "deletedAt"
> & {
  /** Only for copying history in. */
  createdAt?: Date;
  deletedAt?: Date | null;
};

/** What a PATCH may send: any mutable field. Intelligence refuses the immutable ones. */
export type ScheduleChanges<C extends ScheduleCollection> = Partial<
  Omit<
    ScheduleCollections[C],
    "id" | "createdAt" | "updatedAt" | "version" | "deletedAt"
  >
>;

/** A list query: the collection's filters as strings, sets as arrays. */
export type ScheduleFilter = Record<
  string,
  string | number | boolean | Date | null | readonly string[] | undefined
>;

/** One announcement: which record changed, to which version. */
export type ScheduleChange = {
  collection: ScheduleCollection;
  id: string;
  version: number;
  change: "created" | "updated" | "deleted" | "restored" | "purged";
};
