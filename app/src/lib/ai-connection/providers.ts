import type {
  AiConnectionLogin,
  AiConnectionProvider,
} from "@/lib/api/generated/model";

/**
 * The providers Settings offers for the AI connection, in the setup window's order and words.
 *
 * The same list as Desktop's setup window (`catalogue()` in desktop/src-tauri/src/provider.rs), so
 * a person sees the same rows in the app as at setup; ai-connection-providers.test.ts holds the two
 * in step. Kept here as well because a plain browser has no Desktop to ask.
 */
export type AiProvider = {
  id: AiConnectionProvider;
  name: string;
  summary: string;
  /**
   * What the row says where only keys and addresses are offered (a plain browser): the setup
   * window's summary names plans and sign-ins this page can't offer there.
   */
  keySummary: string;
  /** The ways in, in the order the setup window offers them. The first one a page can offer is its default. */
  logins: AiConnectionLogin[];
  /** The vendored mark's id (shared/marks), or null for the row that stands for every provider. */
  mark: string | null;
};

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    summary: "Sign in with ChatGPT Plus, Pro, Team or Enterprise.",
    keySummary: "Use an OpenAI API key.",
    logins: ["plan", "api-key"],
    mark: "openai",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    summary: "Sign in with a Claude Pro, Max, Team or Enterprise plan.",
    keySummary: "Use an Anthropic API key.",
    logins: ["plan", "api-key"],
    mark: "anthropic",
  },
  {
    id: "google",
    name: "Google Gemini",
    summary: "Use a Google AI Studio key or sign in for Gemini API access.",
    keySummary: "Use a Google AI Studio key for the Gemini API.",
    logins: ["endpoint", "oauth"],
    mark: "google-color",
  },
  {
    id: "xai",
    name: "xAI",
    summary: "Use an xAI API key or sign in to your xAI account.",
    keySummary: "Use an xAI API key.",
    logins: ["endpoint", "oauth"],
    mark: "xai",
  },
  {
    id: "unbiased",
    name: "Unbiased AI",
    summary: "Sign in with Unbiased AI to use Pareto, or use an API key.",
    keySummary: "Use an Unbiased AI API key for Pareto.",
    logins: ["oauth", "endpoint"],
    mark: "unbiased",
  },
  {
    id: "openai-compatible",
    name: "Any OpenAI-compatible endpoint",
    summary: "Azure, Bedrock, Mistral, DeepSeek, Ollama, vLLM or your own.",
    keySummary: "Azure, Bedrock, Mistral, DeepSeek, Ollama, vLLM or your own.",
    logins: ["endpoint"],
    mark: null,
  },
];

/**
 * The address, model and key page a named provider's endpoint row fills in, as the setup window's
 * `endpointPresets` (desktop/src/ProviderPicker.tsx). The person types only the key.
 */
export const ENDPOINT_PRESETS: Partial<
  Record<
    AiConnectionProvider,
    { baseUrl: string; model: string; keyUrl: string; keyLink: string }
  >
> = {
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-3.8-flash",
    keyUrl: "https://aistudio.google.com/apikey",
    keyLink: "Get a Google Gemini API key",
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4.7",
    keyUrl: "https://console.x.ai/",
    keyLink: "Get an xAI API key",
  },
  unbiased: {
    baseUrl: "https://api.unbiased.ai/v1",
    model: "pareto",
    keyUrl: "https://platform.unbiased.ai/dashboard/keys",
    keyLink: "Get an Unbiased AI API key",
  },
};

/**
 * The ways in a page can offer. A plan or a sign-in runs in OpenBot Desktop, which holds what renews
 * it, so a plain browser offers keys and addresses only.
 */
export function loginsHere(
  provider: AiProvider,
  inDesktop: boolean,
): AiConnectionLogin[] {
  return provider.logins.filter(
    (login) => inDesktop || login === "api-key" || login === "endpoint",
  );
}

export function providerById(
  id: AiConnectionProvider | null | undefined,
): AiProvider | undefined {
  return AI_PROVIDERS.find((provider) => provider.id === id);
}

/** The host of an address, or null when it isn't one. */
export function hostOf(address: string): string | null {
  try {
    return new URL(address.trim()).host || null;
  } catch {
    return null;
  }
}

/** Whether an address is one the API takes: http or https, with no user name or password in it. */
export function isEndpointAddress(address: string): boolean {
  try {
    const url = new URL(address.trim());
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.host.length > 0 &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}
