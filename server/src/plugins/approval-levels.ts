/**
 * Per-Bot approval levels: how much asking a Bot does before it acts.
 *
 * A grant says a Bot MAY use a tool; this says whether it may do so without checking with a person
 * first. Three levels, because that is the whole ladder an operator wants: never ask, ask before
 * the tools that change things, ask before everything.
 */

/** The ladder, from least to most asking. */
export const APPROVAL_LEVELS = [
  "autonomous",
  "confirm-risky",
  "confirm-all",
] as const;

export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];

/** What a Bot with no configuration set does. Errs toward asking. */
export const DEFAULT_APPROVAL_LEVEL: ApprovalLevel = "confirm-risky";

/** Substrings that mark a tool as one that changes something. Matched against the tool name. */
export const DEFAULT_RISKY_PATTERNS = [
  "send",
  "create",
  "update",
  "delete",
  "post",
  "reply",
  "dm",
  "follow",
  "spend",
  "buy",
  "publish",
];

/** The approval half of an agent's `configuration` jsonb. */
export type ApprovalConfig = {
  approvalLevel: ApprovalLevel;
  riskyPatterns: string[];
};

export function isApprovalLevel(value: unknown): value is ApprovalLevel {
  return (
    typeof value === "string" &&
    (APPROVAL_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * The approval configuration an agent row carries, or the defaults if it carries none.
 *
 * Fail-closed where the stored value is junk: an unreadable level is treated as the asking-est
 * sensible reading rather than the least, and patterns that are not a list of strings are dropped.
 */
export function readApprovalConfig(configuration: unknown): ApprovalConfig {
  const source =
    configuration && typeof configuration === "object"
      ? ((configuration as Record<string, unknown>).approval ??
        configuration)
      : undefined;
  const raw =
    source && typeof source === "object"
      ? (source as Record<string, unknown>)
      : {};

  const level = raw.approvalLevel;
  const patterns = Array.isArray(raw.riskyPatterns)
    ? raw.riskyPatterns.filter(
        (pattern): pattern is string =>
          typeof pattern === "string" && pattern.trim().length > 0,
      )
    : [];

  return {
    approvalLevel: isApprovalLevel(level) ? level : DEFAULT_APPROVAL_LEVEL,
    riskyPatterns: patterns.length > 0 ? patterns : DEFAULT_RISKY_PATTERNS,
  };
}

export type ApprovalDecision = {
  action: "allow" | "ask";
  /** The pattern that made a `confirm-risky` call risky. Absent when the answer is allow. */
  matched?: string;
  reason: string;
};

/**
 * May this tool call go out, or does a person need to say yes first?
 *
 * The tool name is the part after the server id in the ref (`server/tool`), lower-cased, because a
 * pattern list an operator writes should not have to predict the vendor's casing.
 */
export function decide(
  ref: string,
  level: ApprovalLevel,
  patterns: string[] = DEFAULT_RISKY_PATTERNS,
): ApprovalDecision {
  const [, ...rest] = ref.split("/");
  const toolName = (rest.join("/") || ref).toLowerCase();

  // An unknown level asks. This is a boundary, and a boundary that silently allowed on a config
  // typo would be a hole nothing else closes.
  if (level === "confirm-all" || !isApprovalLevel(level)) {
    return {
      action: "ask",
      reason: `${ref} needs approval: this Bot is set to confirm every tool call.`,
    };
  }

  if (level === "autonomous") {
    return {
      action: "allow",
      reason: `${ref} is allowed without asking: this Bot is autonomous.`,
    };
  }

  const matched = patterns.find((pattern) =>
    toolName.includes(pattern.toLowerCase()),
  );
  if (matched) {
    return {
      action: "ask",
      matched,
      reason: `${ref} needs approval: the tool name matches "${matched}", which this Bot's level marks as risky.`,
    };
  }
  return {
    action: "allow",
    reason: `${ref} is allowed without asking: the tool name matches no risky pattern.`,
  };
}
