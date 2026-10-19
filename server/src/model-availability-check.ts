/**
 * Whether the model this deployment's Bots run on is one its key can call, said once at boot.
 *
 * The tenant package names the model (`model.yaml`'s `default_model`), and the provider decides
 * whether a key may use it. A project key without access to that model passes every check OpenBot
 * makes at start-up and fails at the first message, as "The model `…` does not exist or you do not
 * have access to it", in front of whoever sent it. One read of the provider's own model endpoint at
 * boot moves that to the log, where the person who can fix it is looking.
 *
 * Only the providers' own APIs are asked. An OpenAI-compatible endpoint (`OPENAI_BASE_URL`) often
 * serves no single-model lookup, so a 404 there would say nothing about the model; those are left
 * alone. No key configured yet is also left alone: an administrator may still be about to add one.
 * Never blocks start-up and never throws.
 */
export type ModelCheckOutcome =
  | { kind: "available" }
  | { kind: "skipped" }
  | {
      kind: "warning";
      line: {
        type:
          | "model-unavailable"
          | "model-credential-rejected"
          | "model-check-unreadable";
        provider: "openai" | "anthropic";
        model: string;
        status?: number;
        reason?: string;
        fix: string;
      };
    };

type Provider = "openai" | "anthropic";

const ENDPOINTS: Record<Provider, (model: string) => string> = {
  openai: (model) =>
    `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
  anthropic: (model) =>
    `https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`,
};

/** What a provider's answer to "may this key use this model" means for the deployment. */
export function modelCheckOutcome(input: {
  provider: Provider;
  model: string;
  status: number;
}): ModelCheckOutcome {
  const { provider, model, status } = input;
  const keyName =
    provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  if (status >= 200 && status < 300) return { kind: "available" };
  if (status === 404) {
    return {
      kind: "warning",
      line: {
        type: "model-unavailable",
        provider,
        model,
        status,
        fix:
          `The ${provider} key this deployment uses cannot call ${model}, so every Bot turn on it will fail. ` +
          `Give the key access to ${model} (a project key may have a model allowlist), use a key that has it, ` +
          `or change default_model in the tenant package's model.yaml.`,
      },
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: "warning",
      line: {
        type: "model-credential-rejected",
        provider,
        model,
        status,
        fix: `${provider} refused the model key (${keyName} or the credential stored in OpenBot), so every Bot turn will fail until it is replaced.`,
      },
    };
  }
  return {
    kind: "warning",
    line: {
      type: "model-check-unreadable",
      provider,
      model,
      status,
      fix: `${provider} did not say whether ${model} is available (HTTP ${status}). This is often temporary.`,
    },
  };
}

/** Ask once and log what was found. Resolves either way and never throws. */
export async function reportModelAvailability(options: {
  provider: Provider;
  model: string;
  apiKey: () => Promise<string | null>;
  environment?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  timeoutMs?: number;
}): Promise<ModelCheckOutcome> {
  const environment = options.environment ?? process.env;
  const log = options.log ?? ((message: string) => console.warn(message));
  const request = options.fetch ?? fetch;
  const { provider, model } = options;

  const customBase =
    provider === "anthropic"
      ? environment.ANTHROPIC_BASE_URL
      : environment.OPENAI_BASE_URL;
  if (customBase?.trim()) return { kind: "skipped" };

  let outcome: ModelCheckOutcome;
  try {
    const key = await options.apiKey();
    if (!key) return { kind: "skipped" };
    const headers: Record<string, string> =
      provider === "anthropic"
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { authorization: `Bearer ${key}` };
    const response = await request(ENDPOINTS[provider](model), {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    outcome = modelCheckOutcome({ provider, model, status: response.status });
  } catch (error) {
    outcome = {
      kind: "warning",
      line: {
        type: "model-check-unreadable",
        provider,
        model,
        reason: error instanceof Error ? error.message : String(error),
        fix: `Could not ask ${provider} whether ${model} is available. This is often temporary.`,
      },
    };
  }
  if (outcome.kind === "warning") log(JSON.stringify(outcome.line));
  return outcome;
}
