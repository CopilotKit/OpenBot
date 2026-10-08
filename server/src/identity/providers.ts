import { z } from "zod";
import {
  type Identity,
  IdentityInputError,
  type IdentityProvider,
  type LinkMethod,
} from "./types";

type ProviderSpec = {
  title: string;
  /** The proofs this provider's links may be made with. Anything else is refused by the store. */
  methods: readonly LinkMethod[];
  /** For challenge providers: what the person does at the provider to finish. */
  completionHint?: (token: string) => string;
};

export const PROVIDERS: Readonly<Record<IdentityProvider, ProviderSpec>> =
  Object.freeze({
    slack: {
      title: "Slack",
      methods: ["challenge"],
      completionHint: (token) =>
        `From the Slack account that asked for this link, mention the same bot with: /link ${token}`,
    },
    github: { title: "GitHub", methods: ["oauth"] },
  });

export const GITHUB_DOTCOM_REALM = "github.com";

export function isIdentityProvider(value: unknown): value is IdentityProvider {
  return typeof value === "string" && Object.hasOwn(PROVIDERS, value);
}

export function acceptsMethod(provider: IdentityProvider, method: LinkMethod) {
  return PROVIDERS[provider].methods.includes(method);
}

/**
 * The Slack branch matched a sender on connection, installation and workspace. The realm keeps
 * exactly that, each part escaped so a colon inside one part cannot imitate the separator.
 */
export function slackRealm(parts: {
  connectionId: string;
  installationId: string;
  workspaceId: string;
}): string {
  const values = [parts.connectionId, parts.installationId, parts.workspaceId];
  if (values.some((value) => !value.trim()))
    throw new IdentityInputError("Slack identity is incomplete.");
  return values.map(encodeURIComponent).join(":");
}

const identitySchema = z.object({
  provider: z.string().refine(isIdentityProvider),
  realm: z.string().min(1).max(512),
  subject: z.string().min(1).max(256),
});

/** Explicit fields only, so extra runtime properties never reach the persistence contract. */
export function parseIdentity(value: unknown): Identity {
  const parsed = identitySchema.safeParse(value);
  if (!parsed.success) throw new IdentityInputError();
  return {
    provider: parsed.data.provider as IdentityProvider,
    realm: parsed.data.realm,
    subject: parsed.data.subject,
  };
}
