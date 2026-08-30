import type { ChannelIdentityContext } from "@copilotkit/channels";
import type { AgentActor } from "../agents/profile-types";
import type { ExternalLinkAuthorizationStore } from "../external/link-store";
import { mintExternalLinkToken } from "../external/link-token";
import type {
  ExternalProviderIdentity,
  ExternalUserLink,
} from "../external/schema-types";

export type SlackIdentityResult =
  | {
      kind: "linked";
      user: { id: string; name: string };
      actor: AgentActor;
      identity: ExternalProviderIdentity;
    }
  | {
      kind: "unlinked";
      linkUrl: string;
      identity: ExternalProviderIdentity;
    };

export type SlackIdentityLinkerOptions = {
  store: ExternalLinkAuthorizationStore;
  encryptionKey: string;
  appUrl: string | undefined;
};

const APP_URL_ERROR = "Slack link setup requires an absolute OPENBOT_APP_URL.";
const LINK_CONFLICT_ERROR = "That Slack identity is already linked.";
const IDENTITY_ERROR = "Slack identity requires a known tenant and actor id.";

type SlackIdentityFailureCode =
  | "slack_identity_provider_invalid"
  | "slack_identity_actor_kind_invalid"
  | "slack_identity_tenant_invalid"
  | "slack_identity_actor_invalid"
  | "slack_identity_link_lookup_failed"
  | "slack_identity_user_lookup_failed"
  | "slack_identity_email_lookup_failed"
  | "slack_identity_link_write_failed"
  | "slack_identity_link_token_failed";

function identityFailure(
  code: SlackIdentityFailureCode,
  message: string,
  cause?: unknown,
): Error & { code: SlackIdentityFailureCode } {
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    {
      code,
    },
  );
}

async function resolutionStep<T>(
  code: SlackIdentityFailureCode,
  message: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw identityFailure(code, message, error);
  }
}

function canonicalId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.toLowerCase() !== "unknown"
    ? normalized
    : null;
}

async function adapterEmail(
  context: ChannelIdentityContext,
  actorId: string,
): Promise<string | null> {
  try {
    const profile = await context.lookupProfile?.();
    if (profile?.kind !== "human" || canonicalId(profile.id) !== actorId) {
      return null;
    }
    const email = profile?.email?.trim().toLowerCase();
    return email || null;
  } catch {
    // Profile enrichment is optional; a failed lookup must only disable auto-linking.
    return null;
  }
}

function identityFor(
  context: ChannelIdentityContext,
  providerEmail: string | null,
): ExternalProviderIdentity {
  const tenantId = canonicalId(context.tenant.id);
  const actorId = canonicalId(context.actor.id);
  if (context.provider !== "slack")
    throw identityFailure("slack_identity_provider_invalid", IDENTITY_ERROR);
  if (context.actor.kind !== "human")
    throw identityFailure("slack_identity_actor_kind_invalid", IDENTITY_ERROR);
  if (!tenantId)
    throw identityFailure("slack_identity_tenant_invalid", IDENTITY_ERROR);
  if (!actorId)
    throw identityFailure("slack_identity_actor_invalid", IDENTITY_ERROR);
  return {
    provider: "slack",
    providerTenantId: tenantId,
    providerUserId: actorId,
    providerEmail,
  };
}

function linkedResult(
  identity: ExternalProviderIdentity,
  user: { id: string; name: string; role: AgentActor["role"] },
): SlackIdentityResult {
  return {
    kind: "linked",
    user: { id: user.id, name: user.name },
    actor: { id: user.id, role: user.role },
    identity,
  };
}

function configuredAppUrl(appUrl: string | undefined): URL {
  try {
    const url = new URL(appUrl ?? "");
    const hostname = url.hostname.toLowerCase();
    const loopback =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]";
    if (
      url.username ||
      url.password ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    )
      throw new Error();
    return url;
  } catch {
    throw new Error(APP_URL_ERROR);
  }
}

function isLinkConflict(error: unknown): boolean {
  return error instanceof Error && error.message === LINK_CONFLICT_ERROR;
}

export class SlackIdentityLinker {
  constructor(private readonly options: SlackIdentityLinkerOptions) {}

  async resolve(context: ChannelIdentityContext): Promise<SlackIdentityResult> {
    const baseIdentity = identityFor(context, null);
    const existing = await resolutionStep(
      "slack_identity_link_lookup_failed",
      "Slack identity link lookup failed.",
      () =>
        this.options.store.find(
          baseIdentity.provider,
          baseIdentity.providerTenantId,
          baseIdentity.providerUserId,
        ),
    );
    if (existing) {
      const active = await resolutionStep(
        "slack_identity_user_lookup_failed",
        "Slack identity user lookup failed.",
        () => this.options.store.resolveActiveUser(existing.openbotUserId),
      );
      if (active) return linkedResult(existing, active);
      return this.unlinked(existing);
    }

    const profileEmail = await adapterEmail(
      context,
      baseIdentity.providerUserId,
    );
    const identity = { ...baseIdentity, providerEmail: profileEmail };
    if (!profileEmail) return this.unlinked(identity);

    const matched = await resolutionStep(
      "slack_identity_email_lookup_failed",
      "Slack identity email lookup failed.",
      () => this.options.store.findVerifiedUserByEmail(profileEmail),
    );
    if (!matched) return this.unlinked(identity);
    const matchedActive = await resolutionStep(
      "slack_identity_user_lookup_failed",
      "Slack identity user lookup failed.",
      () => this.options.store.resolveActiveUser(matched.id),
    );
    if (!matchedActive) return this.unlinked(identity);

    let linked: ExternalUserLink | null = null;
    try {
      linked = await this.options.store.link({
        ...identity,
        openbotUserId: matched.id,
      });
    } catch (error) {
      if (!isLinkConflict(error)) {
        throw identityFailure(
          "slack_identity_link_write_failed",
          "Slack identity link write failed.",
          error,
        );
      }
    }

    const winner = await resolutionStep(
      "slack_identity_link_lookup_failed",
      "Slack identity link lookup failed.",
      () =>
        this.options.store.find(
          identity.provider,
          identity.providerTenantId,
          identity.providerUserId,
        ),
    );
    const current = winner ?? linked;
    if (!current) return this.unlinked(identity);

    const active = await resolutionStep(
      "slack_identity_user_lookup_failed",
      "Slack identity user lookup failed.",
      () => this.options.store.resolveActiveUser(current.openbotUserId),
    );
    if (!active) return this.unlinked(identity);
    return linkedResult(current, active);
  }

  private async unlinked(
    identity: ExternalProviderIdentity,
  ): Promise<SlackIdentityResult> {
    const url = new URL("/link/slack", configuredAppUrl(this.options.appUrl));
    const token = await resolutionStep(
      "slack_identity_link_token_failed",
      "Slack identity link token creation failed.",
      () => mintExternalLinkToken(identity, this.options.encryptionKey),
    );
    url.searchParams.set("token", token);
    return { kind: "unlinked", linkUrl: url.toString(), identity };
  }
}
