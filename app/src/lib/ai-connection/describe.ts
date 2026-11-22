import type { AiConnection } from "@/lib/api/generated/model";
import { providerById } from "./providers";

/** One line of the AI connection dialog: what it is, and this OpenBot's answer. */
export type AiConnectionDetail = { label: string; value: string };

/** The AI connection in a person's words: who provides it, how OpenBot signs in, and the model. */
export type AiConnectionWords = {
  provider: string;
  /** The row's second line: how OpenBot signs in, and the model when one was named. */
  summary: string;
  details: AiConnectionDetail[];
};

/**
 * Whose key or sign-in it is, in the row's words. `organization` beside a person's own AI (OpenBot
 * Cloud), where the organization's AI is not the reader's: "Uses your organization's OpenAI API
 * key." Everywhere else the reader's: "Uses your OpenAI API key."
 */
export type AiConnectionOwner = "you" | "organization";

/** What Settings says about the AI connection; null when none has been chosen yet. */
export function describeConnection(
  connection: Pick<
    AiConnection,
    "provider" | "login" | "model" | "endpointHost"
  >,
  owner: AiConnectionOwner = "you",
): AiConnectionWords | null {
  const { provider: id, login, model, endpointHost } = connection;
  if (!id || !login) return null;
  const provider = providerById(id)?.name ?? id;
  const your = owner === "organization" ? "your organization's" : "your";
  let signIn: string;
  let said: string;
  switch (login) {
    case "plan":
      signIn = id === "anthropic" ? "Claude plan" : "ChatGPT plan";
      said = `Signed in with ${your} ${signIn}.`;
      break;
    case "oauth":
      signIn = id === "google" ? "Google account" : `${provider} account`;
      said = `Signed in with ${your} ${signIn}.`;
      break;
    case "api-key":
      signIn = "API key";
      said = `Uses ${your} ${provider} API key.`;
      break;
    case "endpoint":
      if (id === "openai-compatible") {
        signIn = endpointHost ?? "Your own address";
        said = endpointHost
          ? `Connected to ${endpointHost}.`
          : `Connected to ${your} own address.`;
      } else {
        signIn = "API key";
        said = `Uses ${your} ${provider} API key.`;
      }
      break;
  }
  const details: AiConnectionDetail[] = [
    { label: "Provider", value: provider },
    {
      label:
        login === "endpoint" && id === "openai-compatible"
          ? "Address"
          : "Sign-in",
      value: signIn,
    },
  ];
  if (model) details.push({ label: "Model", value: model });
  return {
    provider,
    summary: model ? `${said} Model: ${model}` : said,
    details,
  };
}
