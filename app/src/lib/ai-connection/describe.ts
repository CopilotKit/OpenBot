import type {
  AiConnection,
  AiConnectionLogin,
  AiConnectionProviderAnswer,
} from "@/lib/api/generated/model";
import { providerById, signInWords } from "./providers";

/** What describing a connection reads: the single connection's fields, or one in a list. */
export type DescribedConnection = Pick<
  AiConnection,
  "provider" | "login" | "model" | "endpointHost" | "sharedSignIn"
>;

/**
 * A connection's name in a list or a picker group, one per provider: "Claude plan", "ChatGPT plan",
 * "Google sign-in", "OpenAI API key", "Google Gemini API key", or an address's host. Without a way in
 * (a member reading the organization's connections), the provider's name.
 */
export function connectionName(connection: {
  provider: AiConnectionProviderAnswer;
  login: AiConnectionLogin | null;
  endpointHost?: string | null;
}): string {
  const { provider, login, endpointHost } = connection;
  const name = providerById(provider)?.name ?? provider;
  if (login === "plan" || login === "oauth")
    return signInWords(provider, login);
  if (provider === "openai-compatible") return endpointHost ?? name;
  if (login === "api-key" || login === "endpoint") return `${name} API key`;
  return name;
}

/** One line of the AI connection dialog: what it is, and this OpenBot's answer. */
export type AiConnectionDetail = { label: string; value: string };

/** The AI connection in a person's words: who provides it, how OpenBot signs in, and the model. */
export type AiConnectionWords = {
  provider: string;
  /** The row's second line: how OpenBot signs in, and the model when one was named. */
  summary: string;
  details: AiConnectionDetail[];
  /**
   * Whose own sign-in the organization's AI shares, on OpenBot Cloud: "Dana Reyes's Claude plan",
   * or "your Claude plan" when it is the reader's. `ready` false once it stopped working.
   */
  shared: { words: string; ready: boolean } | null;
};

/** "Dana Reyes's", by the name OpenBot shows for them. */
function possessive(name: string): string {
  return `${name}'s`;
}

/**
 * Whose key or sign-in it is, in the row's words. `organization` beside a person's own AI (OpenBot
 * Cloud), where the organization's AI is not the reader's: "Uses your organization's OpenAI API
 * key." Everywhere else the reader's: "Uses your OpenAI API key."
 */
export type AiConnectionOwner = "you" | "organization";

/** What Settings says about the AI connection; null when none has been chosen yet. */
export function describeConnection(
  connection: DescribedConnection,
  owner: AiConnectionOwner = "you",
  /** The reader's person id, so a sign-in they shared reads as theirs. */
  viewerId?: string,
): AiConnectionWords | null {
  const { provider: id, login, model, endpointHost, sharedSignIn } = connection;
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
  // A plan or a sign-in an admin shared from their own: whose it is, never "your organization's".
  const shared =
    sharedSignIn && (login === "plan" || login === "oauth")
      ? {
          words: `${
            sharedSignIn.personId === viewerId
              ? "your"
              : possessive(sharedSignIn.name)
          } ${signIn}`,
          ready: sharedSignIn.ready,
        }
      : null;
  if (shared) said = `Shared from ${shared.words}.`;
  const details: AiConnectionDetail[] = [
    { label: "Provider", value: provider },
    {
      label:
        login === "endpoint" && id === "openai-compatible"
          ? "Address"
          : "Sign-in",
      value: shared
        ? `${shared.words.charAt(0).toUpperCase()}${shared.words.slice(1)}`
        : signIn,
    },
  ];
  if (model) details.push({ label: "Model", value: model });
  return {
    provider,
    summary: model ? `${said} Model: ${model}` : said,
    details,
    shared,
  };
}
