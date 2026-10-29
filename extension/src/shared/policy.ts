import { isAllowedGatewayUrl, normaliseOpenBotOrigin } from "./origin";

/** `openbotUrlInvalid`: the policy names an address normaliseOpenBotOrigin refuses; every connect is then refused. */
export type RecorderPolicy = {
  openbotUrl: string | null;
  openbotUrlInvalid: boolean;
  allowedIntelligenceUrls: string[] | null;
};

function openbotUrlFrom(
  value: unknown,
): Pick<RecorderPolicy, "openbotUrl" | "openbotUrlInvalid"> {
  if (value === undefined)
    return { openbotUrl: null, openbotUrlInvalid: false };
  const checked =
    typeof value === "string" ? normaliseOpenBotOrigin(value.trim()) : null;
  // The bad string is dropped here, so no surface can show or parse it.
  return checked?.ok
    ? { openbotUrl: checked.origin, openbotUrlInvalid: false }
    : { openbotUrl: null, openbotUrlInvalid: true };
}

/** Absent: no restriction. Present: only the valid wss:// entries (ws:// for a loopback IP); none left refuses every pass.
 *
 * Chrome publishes a managed value only when it matches managed_schema.json, and a schema names exactly one type, so a
 * value IT wrote with the wrong type (a single string, a Windows REG_MULTI_SZ) never reaches this function: it reads as
 * absent, no restriction. No schema can widen that, so the schema's description and the company install guide tell IT
 * to check chrome://policy. The non-list branch below is a guard for a Chrome that published one anyway. */
function allowedUrlsFrom(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && isAllowedGatewayUrl(entry, null),
  );
}

function policyFrom(managed: Record<string, unknown>): RecorderPolicy {
  return {
    ...openbotUrlFrom(managed.OpenBotUrl),
    allowedIntelligenceUrls: allowedUrlsFrom(managed.AllowedIntelligenceUrls),
  };
}

export async function readPolicy(): Promise<RecorderPolicy> {
  return policyFrom(await chrome.storage.managed.get(null));
}

/** Whether the policy lets this browser connect to (and stay connected to) `origin`: never under an invalid policy,
 * and only to the pinned OpenBot when one is pinned. */
export function allowsOpenBot(policy: RecorderPolicy, origin: string): boolean {
  if (policy.openbotUrlInvalid) return false;
  if (policy.openbotUrl === null) return true;
  const checked = normaliseOpenBotOrigin(origin);
  return checked.ok && checked.origin === policy.openbotUrl;
}

export function onPolicyChanged(
  listener: (policy: RecorderPolicy) => void,
  read: () => Promise<RecorderPolicy> = readPolicy,
): () => void {
  const onChanged = (_changes: unknown, area: string) => {
    if (area !== "managed") return;
    void read().then(listener);
  };
  chrome.storage.onChanged.addListener(onChanged);
  return () => chrome.storage.onChanged.removeListener(onChanged);
}
