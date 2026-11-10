/**
 * The filters a question about the audit trail becomes, and the query string they travel as.
 *
 * One shape for three readers: the model's answer is checked against it on the server, the Audit page
 * draws it as chips, and `GET /api/admin/audit-events` reads the query string it turns into. Each
 * filter narrows the rows (they are joined with AND), and the values inside one filter are
 * alternatives (joined with OR), the way `eventType` has always taken several.
 */

/** What an action does, as the boundary sees it (`intent` in `server/src/computer/policy.ts`). */
export const AUDIT_INTENTS = [
  "activate",
  "type",
  "navigate",
  "read",
  "read_file",
  "download_file",
  "write_file",
  "list_files",
  "run_command",
  "read_tool",
  "write_tool",
] as const;

export type AuditIntent = (typeof AUDIT_INTENTS)[number];

/** Each intent in words, for a chip and for the model reading the filters back. */
export const AUDIT_INTENT_WORDS: Record<AuditIntent, string> = {
  activate: "Press a button or link",
  type: "Type or press a key",
  navigate: "Open a page",
  read: "Scroll or read a page",
  read_file: "Read a file",
  download_file: "Download a file",
  write_file: "Save a file",
  list_files: "List files",
  run_command: "Run a command",
  read_tool: "App call that reads",
  write_tool: "App call that changes something",
};

export const AUDIT_EFFECTS = ["read", "write"] as const;
export type AuditEffect = (typeof AUDIT_EFFECTS)[number];

export const AUDIT_EFFECT_WORDS: Record<AuditEffect, string> = {
  read: "Reads",
  write: "Changes something",
};

/** The `mcp.call_*` rows: an app's tool call, with its app, tool and effect in the payload. */
export const APP_CALL_EVENT_TYPES = [
  "mcp.call_succeeded",
  "mcp.call_failed",
  "mcp.call_rejected",
] as const;

/** The rows the boundary refused, each naming the rule that refused it in `decision.rule`. */
export const RULE_REFUSAL_EVENT_TYPES = [
  "computer.action_refused",
  "mcp.call_rejected",
] as const;

export type AuditFilters = {
  /** Event types, any of them. */
  eventType?: string[];
  /** One Bot: what it did and what was done to it, as the `bot` parameter has always read. */
  bot?: string;
  /** One person, by user id: whose authority the rows ran on. */
  actorUserId?: string;
  /** What started the run, any of them: `person`, `routine`, `handoff` and the rest. */
  initiatorKind?: string[];
  /** Apps, by {@link appKey}: an app's tool calls, whichever broker it came through. */
  app?: string[];
  /** Tools, by the name the trail records (`GMAIL_SEND_EMAIL`), any of them. */
  tool?: string[];
  /** An app call that only reads, or one that changes something. */
  effect?: AuditEffect;
  /** What an action did, any of them. */
  intent?: AuditIntent[];
  /** The boundary rule that refused it, exactly as written. One, because a rule can hold commas. */
  rule?: string;
  /** After this moment, ISO 8601. */
  from?: string;
  /** Before this moment, ISO 8601. */
  to?: string;
};

/** The filters in the order a chip row and a reading list them. */
export const AUDIT_FILTER_KEYS = [
  "bot",
  "actorUserId",
  "initiatorKind",
  "eventType",
  "app",
  "tool",
  "effect",
  "intent",
  "rule",
  "from",
  "to",
] as const satisfies readonly (keyof AuditFilters)[];

export type AuditFilterKey = (typeof AUDIT_FILTER_KEYS)[number];

const LISTS = new Set<AuditFilterKey>([
  "eventType",
  "initiatorKind",
  "app",
  "tool",
  "intent",
]);

/** Whether the filters narrow anything at all. */
export function hasAuditFilters(filters: AuditFilters): boolean {
  return AUDIT_FILTER_KEYS.some((key) => {
    const value = filters[key];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });
}

/**
 * The filters as query parameters, in a stable order, so one set of filters is one cache entry.
 * Empty filters leave no parameter behind.
 */
export function auditFilterParams(filters: AuditFilters): [string, string][] {
  const params: [string, string][] = [];
  for (const key of AUDIT_FILTER_KEYS) {
    const value = filters[key];
    if (Array.isArray(value)) {
      if (value.length > 0) params.push([key, value.join(",")]);
    } else if (typeof value === "string" && value !== "") {
      params.push([key, value]);
    }
  }
  return params;
}

/** The filters read back from a query string, the way the server reads them. */
export function auditFiltersFromParams(params: URLSearchParams): AuditFilters {
  const filters: AuditFilters = {};
  for (const key of AUDIT_FILTER_KEYS) {
    const raw = params.get(key);
    if (raw === null || raw.trim() === "") continue;
    if (LISTS.has(key)) {
      const values = raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (values.length > 0) (filters as Record<string, unknown>)[key] = values;
    } else {
      (filters as Record<string, unknown>)[key] = raw;
    }
  }
  return filters;
}

const BROKERS = /^(composio|arcade)-/i;

/**
 * An app, however the trail spells its server: `composio-gmail`, `arcade-Gmail` and `gmail` are all
 * `gmail`, and `google-drive`, `googledrive` and `composio-google_drive` are all `googledrive`.
 *
 * The broker an app came through is how it was connected, not which app it is, and the person asking
 * "what did Bots do in Gmail" means every one of them. The same normalisation runs in SQL in
 * `server/src/audit-filters.ts`; a test holds the two together.
 */
export function appKey(server: string): string {
  return server
    .replace(BROKERS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
