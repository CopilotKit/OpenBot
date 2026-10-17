// Feature off until Task 22 replaces it.
/** `openbotUrlInvalid`: the policy names an address normaliseOpenBotOrigin refuses; every connect is then refused (Task 22). */
export type RecorderPolicy = {
  openbotUrl: string | null;
  openbotUrlInvalid: boolean;
  allowedIntelligenceUrls: string[] | null;
};

export async function readPolicy(): Promise<RecorderPolicy> {
  return {
    openbotUrl: null,
    openbotUrlInvalid: false,
    allowedIntelligenceUrls: null,
  };
}

export function onPolicyChanged(
  _listener: (policy: RecorderPolicy) => void,
): () => void {
  return () => {};
}
