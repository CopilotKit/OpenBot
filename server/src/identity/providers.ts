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
  /** For challenge providers: what the person sends from their account there, carrying the code. */
  instruction?: (code: string) => string;
};

export const PROVIDERS: Readonly<Record<IdentityProvider, ProviderSpec>> =
  Object.freeze({
    slack: {
      title: "Slack",
      methods: ["challenge"],
      instruction: (code) =>
        `Send this message to the OpenBot bot in Slack: link ${code}`,
    },
    github: { title: "GitHub", methods: ["oauth"] },
  });

const REALM_MAX = 512;

export const GITHUB_DOTCOM_REALM = "github.com";

export function isIdentityProvider(value: unknown): value is IdentityProvider {
  return typeof value === "string" && Object.hasOwn(PROVIDERS, value);
}

export function acceptsMethod(provider: IdentityProvider, method: LinkMethod) {
  return PROVIDERS[provider].methods.includes(method);
}

/**
 * A Slack user id is only unique within one workspace reached through one installation of one
 * connection, so the realm is those three parts, each escaped so a colon inside one part cannot
 * imitate the separator.
 */
export function slackRealm(parts: {
  connectionId: string;
  installationId: string;
  workspaceId: string;
}): string {
  const values = [parts.connectionId, parts.installationId, parts.workspaceId];
  if (values.some((value) => !value.trim() || value !== value.trim()))
    throw new IdentityInputError("Slack identity is incomplete.");
  const realm = values.map(encodeURIComponent).join(":");
  if (realm.length > REALM_MAX)
    throw new IdentityInputError("Slack identity is too long.");
  return realm;
}

// Provider ids never contain whitespace: reject blank values but keep others exactly as given.
const nonBlank = (value: string) => value.trim().length > 0;

const identitySchema = z.object({
  provider: z.string().refine(isIdentityProvider),
  realm: z.string().max(REALM_MAX).refine(nonBlank),
  subject: z.string().max(256).refine(nonBlank),
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
