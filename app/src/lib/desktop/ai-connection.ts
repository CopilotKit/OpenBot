import type { DesktopAiConnection } from "./queries";

/** One line of the AI model dialog: what it is, and this installation's answer. */
export type AiConnectionDetail = { label: string; value: string };

/** The AI connection in a person's words: who provides it, how OpenBot signs in, and the model. */
export type AiConnectionSummary = {
  provider: string;
  /** The row's second line: how OpenBot signs in, and the model when one was named. */
  summary: string;
  details: AiConnectionDetail[];
};

/**
 * The addresses the setup window fills in for a provider's own row (`endpointPresets` in
 * desktop/src/ProviderPicker.tsx), by host. Any other address is the person's own.
 */
const PRESET_HOSTS: Record<string, string> = {
  "generativelanguage.googleapis.com": "Google Gemini",
  "api.x.ai": "xAI",
  "api.unbiased.ai": "Unbiased AI",
};

function signedIn(
  kind: NonNullable<DesktopAiConnection["kind"]>,
  host: string | null,
): { provider: string; signIn: string; said: string } {
  switch (kind) {
    case "claude-plan":
      return {
        provider: "Anthropic",
        signIn: "Claude plan",
        said: "Signed in with your Claude plan.",
      };
    case "chat-gpt-plan":
      return {
        provider: "OpenAI",
        signIn: "ChatGPT plan",
        said: "Signed in with your ChatGPT plan.",
      };
    case "anthropic-api-key":
      return {
        provider: "Anthropic",
        signIn: "API key",
        said: "Uses your Anthropic API key.",
      };
    case "open-ai-api-key":
      return {
        provider: "OpenAI",
        signIn: "API key",
        said: "Uses your OpenAI API key.",
      };
    case "google-oauth":
      return {
        provider: "Google Gemini",
        signIn: "Google account",
        said: "Signed in with your Google account.",
      };
    case "xai-oauth":
      return {
        provider: "xAI",
        signIn: "xAI account",
        said: "Signed in with your xAI account.",
      };
    case "compatible-endpoint": {
      const preset = host ? PRESET_HOSTS[host] : undefined;
      if (preset)
        return {
          provider: preset,
          signIn: "API key",
          said: `Uses your ${preset} API key.`,
        };
      return {
        provider: "OpenAI-compatible",
        signIn: host ?? "Your own address",
        said: host ? `Connected to ${host}.` : "Connected to your own address.",
      };
    }
  }
}

/** What Settings says about the AI connection; null when none has been chosen yet. */
export function describeAiConnection(
  connection: DesktopAiConnection,
): AiConnectionSummary | null {
  if (!connection.kind) return null;
  const { provider, signIn, said } = signedIn(
    connection.kind,
    connection.endpointHost,
  );
  const details: AiConnectionDetail[] = [
    { label: "Provider", value: provider },
    {
      label:
        connection.kind === "compatible-endpoint" && signIn !== "API key"
          ? "Address"
          : "Sign-in",
      value: signIn,
    },
  ];
  if (connection.model)
    details.push({ label: "Model", value: connection.model });
  return {
    provider,
    summary: connection.model ? `${said} Model: ${connection.model}` : said,
    details,
  };
}
