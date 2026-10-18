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

/** Absent: no restriction. Present: only the valid wss:// entries (ws:// for a loopback IP); none left refuses every pass. */
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

export function onPolicyChanged(
  listener: (policy: RecorderPolicy) => void,
): () => void {
  const onChanged = (_changes: unknown, area: string) => {
    if (area !== "managed") return;
    void readPolicy().then(listener);
  };
  chrome.storage.onChanged.addListener(onChanged);
  return () => chrome.storage.onChanged.removeListener(onChanged);
}
