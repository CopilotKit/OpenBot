import manifest from "./model-lock.json";

/**
 * THE MODEL LOCK: which models each harness has been proven to run, with the client versions it
 * was proven on.
 *
 * WHY. The model picker lists each provider's models live, but every harness image carries its
 * model client at a fixed version, and a provider can refuse a new model to an older client
 * ("Claude Code 2.1.259 does not support this model; version 2.1.290 or newer is required"). A
 * Bot set to such a model fails on every message. So a live model is offered only when the daily
 * model check (scripts/model-compat.ts) has sent it one real request through that harness's
 * own client and it answered.
 *
 * WHERE THE DATA COMES FROM. `model-lock.json` is written by `bun scripts/model-compat.ts lock`
 * from the check's results, never by hand. The daily check opens a pull request when a model newly
 * passes or starts failing, and a pull request that changes a harness's client checks that
 * harness before it merges. See docs/releasing.md, "Model lock".
 *
 * THE RULE. A harness and provider pair the check has run is locked: only the models that passed
 * are offered. A pair it has never run (no key for that provider in CI, or an engine it has no
 * entry for) is open: nothing is known, so nothing is taken away. A model the provider lists that the
 * check has not reached yet (released since the last run) is not offered until it passes.
 */

/** Who serves the models, as the lock names them. `chatgpt` is a ChatGPT plan's Codex backend. */
export type LockProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "chatgpt";

export type LockedProvider = {
  /** The model ids that answered through this harness's client. */
  verified: string[];
  /** The model ids the provider refused through this client, with what it said. */
  refused: Record<string, string>;
};

export type LockedEngine = {
  /** The model-client packages in the image the check ran, with their versions. */
  clients: Record<string, string>;
  providers: Partial<Record<LockProvider, LockedProvider>>;
};

export type ModelLock = {
  /** The day of the run the lock was written from, `YYYY-MM-DD`. */
  checkedAt: string;
  /** By harness image directory (`agent-claude-sdk`), as `shared/harnesses.json` names it. */
  engines: Record<string, LockedEngine>;
};

export const MODEL_LOCK: ModelLock = manifest as ModelLock;

/**
 * The engines new Bots run on unless somebody picks another. A locked pair on one of these with
 * nothing verified would leave every new Bot with no model to offer on that provider, so a test
 * holds each to at least one (scripts/model-lock.test.ts).
 */
export const DEFAULT_ENGINES: readonly string[] = ["agent-langgraph-ts"];

/** The locked pairs of an engine that verify nothing: no model would be offered on them. */
export function emptyPairs(lock: ModelLock, engine: string): LockProvider[] {
  const providers = lock.engines[engine]?.providers ?? {};
  return (Object.keys(providers) as LockProvider[]).filter(
    (provider) => (providers[provider]?.verified.length ?? 0) === 0,
  );
}

/**
 * What the lock says about one model on one harness and provider.
 *
 * - `verified`: it answered through the harness's own client.
 * - `refused`: the provider turned it down through that client; `said` is the provider's words.
 * - `unchecked`: the pair is locked, and this model was not in the run (released since).
 * - `open`: the pair was never checked, or the lock has no entry for the engine.
 */
export type LockVerdict =
  | { status: "verified" }
  | { status: "refused"; said: string }
  | { status: "unchecked" }
  | { status: "open" };

export function lockVerdict(
  lock: ModelLock,
  engine: string | undefined,
  provider: LockProvider | undefined,
  model: string,
): LockVerdict {
  const pair =
    engine && provider ? lock.engines[engine]?.providers[provider] : undefined;
  if (!pair) return { status: "open" };
  if (pair.verified.includes(model)) return { status: "verified" };
  const said = pair.refused[model];
  return said === undefined
    ? { status: "unchecked" }
    : { status: "refused", said };
}

/** Whether a model may be offered: proven on the pair, or the pair is not locked. */
export function lockAllows(
  lock: ModelLock,
  engine: string | undefined,
  provider: LockProvider | undefined,
  model: string,
): boolean {
  const { status } = lockVerdict(lock, engine, provider, model);
  return status === "verified" || status === "open";
}
