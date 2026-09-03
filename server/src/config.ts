/**
 * What the runtime can do. There is exactly one answer because CopilotKit Intelligence is required
 * for durable threads and memory. Configuration the product cannot function without belongs at the
 * boot boundary.
 */
import { singleUserEnabled } from "./auth/dev-actor";
import type { ActionPolicy } from "./computer/policy";
import { parseActionPolicy } from "./computer/policy-store";

export type RuntimeCapabilities = {
  mode: "intelligence";
  durableHistory: true;
  intelligence: IntelligenceSettings;
};

/** The Intelligence contract. Every field is required; see runtimeCapabilities. */
export type IntelligenceSettings = {
  apiUrl: string;
  gatewayWsUrl: string;
  apiKey: string;
  licenseToken: string;
};

export type DockerComputerConfig = {
  provider: "docker";
  baseUrl: string;
  supervisorToken?: string;
  token?: string;
  allowPrivateHosts: boolean;
  policy?: ActionPolicy;
};

export type SharedComputerConfig = {
  provider: "shared";
  baseUrl: string;
  token?: string;
  allowPrivateHosts: boolean;
  policy?: ActionPolicy;
};

/**
 * A computer each, created by the cluster.
 *
 * The namespace is the whole scope: the service account this runs under may manage Sandboxes there
 * and nowhere else, which is a smaller blast radius than the Docker supervisor's, since that one
 * holds a socket that is root-equivalent on its host.
 */
export type SandboxComputerConfig = {
  provider: "sandbox";
  namespace: string;
  idleAfterMs: number;
  /** Where the chart mounted the shape of a computer. */
  templateFile: string;
  token?: string;
  allowPrivateHosts: boolean;
  policy?: ActionPolicy;
};

export type ComputerConfig =
  | DockerComputerConfig
  | SharedComputerConfig
  | SandboxComputerConfig;

/**
 * The deployment's own mailbox: where it is and which accounts it signs in as.
 *
 * NO PASSWORD HERE, and that is the point of the shape. Everything in this file comes from the
 * environment, which means a `.env` file on a laptop, a compose file in a repository and whatever a
 * cluster hands a container as plain text. The mailbox passwords are the only secrets in this
 * feature, so they live where the other secrets this deployment holds live: the encrypted
 * credential vault, one credential per account, keyed by the address. See
 * `plugins/builtin-mailbox.ts` for how one is resolved.
 *
 * Both ports default to the implicit-TLS ones (993 and 465) rather than to the STARTTLS ones, so a
 * deployment that sets only the two hosts gets an encrypted connection rather than one that
 * negotiates for it in the clear.
 */
export type MailboxConfig = {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /**
   * The accounts on these hosts, lower-cased and in the order they were configured.
   *
   * Never empty: a mailbox with no account is refused at start-up rather than carried around as a
   * shape every caller has to check. The FIRST is the default, which is the one a tool call that
   * named no account works in, so the order in `MAILBOX_USERS` is a decision rather than a detail.
   *
   * Several accounts, one set of hosts: this is the shared-hosting shape, where `support@`,
   * `sales@` and `billing@` are all mailboxes on the same IMAP and SMTP servers with a password
   * each. Each password is its own vault credential, keyed by the address.
   */
  users: readonly string[];
  /**
   * The domains a Bot may send to. Empty means anywhere, which is the default.
   *
   * WHY A DEPLOYMENT MIGHT WANT THIS. The policy engine sees a tool call's NAME and its effect, not
   * its arguments, so no rule can say "may email the company and nobody else": the only thing a
   * rule can do about `send_message` is require approval for all of it or none of it. That leaves a
   * gap this closes: the read tools bring text somebody else wrote into a model's context, and a
   * Bot holding read plus unconstrained send is one persuasive message away from mailing the inbox
   * to whoever asked. An allowlist bounds where anything can go, without a person in the loop.
   *
   * It is a floor and not a substitute for the approval rule. Inside the allowed domains the Bot
   * can still send whatever it was talked into, so a deployment that cares should have both.
   */
  allowedRecipientDomains: ReadonlySet<string>;
};

/**
 * Who a deployment lets in, and through which front door.
 *
 * One identity provider is a product decision somebody else already made. A company running this
 * has Google or Entra or Okta and is not going to acquire another, so the shape here is a set of
 * optional providers rather than one required one, and the deployment turns on whichever it has.
 */
export type AuthProviderId = "google" | "microsoft" | "okta";

/** An OAuth client, as every provider here needs one. */
export type OAuthClient = { clientId: string; clientSecret: string };

export type AuthConfig = {
  baseUrl: string;
  secret: string;
  trustedOrigins: string[];
  initialAdminEmails: string[];
  google?: OAuthClient;
  /**
   * `tenantId` decides who may sign in at all, so it is not a detail. `common` admits any Microsoft
   * account including personal ones, `organizations` any work or school account anywhere, and a GUID
   * admits one directory. A deployment that wants only its own company needs the GUID.
   */
  microsoft?: OAuthClient & { tenantId: string };
  /** Okta is an OIDC provider rather than a named one, so it is identified by its issuer. */
  okta?: OAuthClient & { issuer: string };
};

/**
 * The providers this deployment can actually sign somebody in with.
 *
 * Ordered, and deliberately not alphabetically: this is the order the buttons appear in, and it is
 * fixed here rather than left to object key order so the sign-in screen cannot change shape because
 * of how a configuration happened to be written.
 */
export function configuredAuthProviders(
  auth: AuthConfig | undefined,
): AuthProviderId[] {
  if (!auth) return [];
  const providers: AuthProviderId[] = [];
  if (auth.google) providers.push("google");
  if (auth.microsoft) providers.push("microsoft");
  if (auth.okta) providers.push("okta");
  return providers;
}

export type ManagedAgentConfig = {
  endpoint: URL;
  /** Secret sent only to the managed Bot endpoint. Never stored in an agent row. */
  token: string;
};

/**
 * How far one Bot handing work to another may go.
 *
 * NUMBERS A DEPLOYMENT CHOOSES, not constants. A small team and a company running this across
 * departments want different answers, and neither should have to edit code to get one.
 *
 * Both defaults are deliberately mean. A hop costs a whole agent turn at the other end, fan-out
 * shapes cost several times a single run because each Bot spends its own full budget, and on a
 * cluster a hop to a Bot whose computer is asleep also pays a pod resume. One level of delegation is
 * what most systems allow by default, and a deployment that wants more can say so.
 */
export type HandoffCaps = {
  /** How many Bots deep a chain may go. `0` switches the whole capability off. */
  maxDepth: number;
  /** How many other Bots one run may address. */
  maxPerRun: number;
};

export type DeploymentConfig = {
  databaseUrl: string;
  keyEncryptionKey: string;
  /**
   * The Bot in the box, when this deployment has one.
   *
   * Absent is the one-container image: it carries no AG-UI process, and a required URL would
   * register a coworker against a host that is not there. Set both the URL and the token together
   * when a remote Bot is actually running.
   */
  managedAgent?: ManagedAgentConfig;
  /**
   * Private addresses an agent may be registered at, named one at a time.
   *
   * WHY THIS EXISTS. `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` is a floor, not a permission: it opens this
   * deployment's whole network, to browsing and to agent endpoints alike, which is why a production
   * deployment refuses to start with it on. That left bring-your-own-agent — a headline capability —
   * unusable in the image people are told to deploy, because a company's own agent legitimately lives
   * at an internal address and the only way to reach it was to drop the floor.
   *
   * So the address is named instead. Nothing else is opened, browsing is not widened, and the
   * never-allowed list is still checked first, so the metadata address cannot be named back in.
   * Empty by default, which is the same posture as before for anybody who does not set it.
   */
  agentEndpointAllowedHosts: ReadonlySet<string>;
  /**
   * What this deployment calls itself, when more than one shares an Intelligence project.
   *
   * Absent, the tenant package's id stands in, which separates deployments running different
   * packages but not a copy of one running alongside the original. See channels/thread-identity.ts.
   */
  deploymentId: string | undefined;
  /**
   * Where this deployment is reached from outside, with no trailing slash.
   *
   * Needed because an OAuth redirect URI has to match what an administrator registered with the
   * vendor character for character, and it is shown on the Plugins page for them to copy. Built from
   * configuration rather than from the incoming request: a redirect URI assembled out of a Host
   * header is one an attacker has a say in.
   *
   * `OPENBOT_PUBLIC_URL` when set, otherwise `BETTER_AUTH_URL`, which is the same public address for
   * every deployment that has real sign-in. Undefined only where neither exists, which is a local
   * deployment running without authentication — and there is nothing to connect there anyway.
   */
  publicUrl: string | undefined;
  /**
   * Where the browser app is served from, with no trailing slash.
   *
   * Separate from {@link DeploymentConfig.publicUrl} because they are genuinely two addresses: the
   * app is a Vite process on its own port locally, and the API is another. An OAuth callback lands on
   * the API and has to send the person back to a page, so a relative redirect would put them on the
   * API's origin, where no page exists.
   *
   * `OPENBOT_APP_URL` when set, otherwise the first `TRUSTED_ORIGINS` entry, which is already defined
   * as where the app is served from. Falls back to the API's own public URL, which is right for a
   * deployment serving both from one origin.
   */
  appUrl: string | undefined;
  tenantPackageDirectory: string;
  runtime: RuntimeCapabilities;
  /**
   * How long a Bot's stream may say nothing before this deployment ends the turn, in milliseconds.
   *
   * Zero means no watchdog, and an unset variable means zero. A turn that is ended is a turn
   * somebody loses, so a deployment that has not said it wants that gets the behaviour it already
   * had. `.env.example` ships a value, so a new clone starts with the watch on and an upgraded
   * deployment does not acquire it without being asked.
   */
  agentStallTimeoutMs: number;
  /**
   * How many days of audit trail this deployment keeps, or undefined to keep everything.
   *
   * Undefined by default. Deleting somebody's audit trail because a default said so is the worse of
   * the two failures, and a deployment that has not thought about retention should keep everything
   * until it has.
   */
  auditRetentionDays: number | undefined;
  oauth: {
    google?: { clientId: string; clientSecret: string };
  };
  auth?: AuthConfig;
  /**
   * Admit everybody as one fixed administrator instead of requiring sign-in.
   *
   * True only when no identity provider is configured. See auth/dev-actor.ts for what stops this
   * reaching somewhere other people can get to.
   */
  singleUser: boolean;
  /** Names OpenBot on the analytics the runtime already sends. Off with OPENBOT_ACCESSIBILITY_DISABLED. */
  accessibility: boolean;
  /**
   * Whether a Bot may answer with an interface it wrote itself.
   *
   * This is not the component catalogue. A component is something this deployment holds: it was
   * either compiled into the build or authored in the playground, an administrator granted it to a
   * Bot, and all a Bot decides is which of them to draw. Here there is nothing to grant, because
   * there is nothing yet — the Bot writes the markup, the styles and the script for this one answer,
   * and they are gone when the conversation moves on.
   *
   * A deployment switch rather than a per-Bot grant because the SDK offers no seam for one. The
   * interface is painted from activity events that only the runtime middleware emits, and the tool
   * the model calls is registered by the browser for every Bot the moment that middleware is on.
   * Narrowing the middleware to some Bots would leave the rest able to call the tool and draw
   * nothing at all, which is a worse answer than never offering it.
   *
   * Off until a deployment sets OPENBOT_GENERATIVE_UI. A capability that runs code a model wrote is
   * one an operator should choose, not one they should discover after an upgrade — and a deployment
   * that builds its default branch automatically would otherwise acquire it without a decision.
   *
   * What it runs is sandboxed by the SDK, in an iframe with no same-origin access to this app, so a
   * generated interface reaches this deployment's data only through what the host hands it. This
   * deployment hands it nothing. It can load libraries from a CDN, which is the part a deployment
   * that must not reach the public internet from a browser tab needs to weigh.
   */
  generativeUi: boolean;
  /**
   * Where the built app is, when this process serves it.
   *
   * Set in a container image that carries both. Unset in development, where Vite serves the app and
   * proxies the API here, so the server stays an API and nothing shadows a route.
   */
  appDistDir?: string;
  /**
   * The Bot computer. Absent means the feature is off and its routes are not mounted, rather than
   * mounted and failing: a capability that is not configured should be missing, not broken.
   */
  computer?: ComputerConfig;
  /**
   * The deployment's mailbox. Absent means the Mailbox tools refuse rather than fail.
   *
   * Unlike {@link DeploymentConfig.computer}, absence does not unmount anything: the catalogue entry
   * stays admissible and its tools stay grantable, because a Bot's grants are an administrator's
   * decision and should not evaporate because a variable was unset during a deploy. What absence
   * changes is what a call answers: a sentence naming the four things to set, rather than a
   * connection attempt to nowhere.
   */
  mailbox?: MailboxConfig;
  /** How far one Bot handing work to another may go. */
  handoff: HandoffCaps;
  /**
   * The secret a Bot presents when it calls a tool back through this server.
   *
   * A framework Bot runs its own tool loop, in its own process, which is what makes it a real
   * harness rather than a shape the browser drives. It still may not reach a vendor directly: it
   * calls here, and here is where the grant, the policy and the audit row are. This is what tells
   * that call apart from anybody else on the network.
   *
   * Absent means no Bot may call tools back, and a deployment that wanted them gets a refusal rather
   * than an open door.
   */
  agentToolToken?: string;
  /**
   * The secret the worker presents when it hands a routine run back to this server.
   *
   * Absent means the internal routines endpoint refuses everything, which is the correct state of a
   * deployment with no worker — a deployment that has not asked for scheduled turns should not have a
   * door for them standing open.
   */
  workerSharedSecret?: string;
};

type Environment = Record<string, string | undefined>;

/**
 * The caps, read from the environment, refusing anything that is not a whole number at least zero.
 *
 * Refused rather than coerced. A cap is a safety number, and a deployment that typed `two` and got
 * the default would believe it had set one: the failure has to be at start-up where somebody is
 * looking, not at the first loop.
 */
function handoffCaps(environment: Environment): HandoffCaps {
  const read = (name: string, fallback: number): number => {
    const raw = optional(environment, name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a whole number of zero or more`);
    }
    return value;
  };
  return {
    // One level of delegation, which is what most systems allow before anybody asks for more.
    maxDepth: read("BOT_HANDOFF_MAX_DEPTH", 1),
    maxPerRun: read("BOT_HANDOFF_MAX_PER_RUN", 3),
  };
}

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function optional(environment: Environment, name: string): string | undefined {
  return environment[name]?.trim() || undefined;
}

/**
 * The key in `.env.example`, which every clone of this repository starts with.
 *
 * It is a valid key, which is the whole problem: it is the right length and the right encoding, so
 * nothing about it fails a check. A deployment that never changed it encrypts its credential vault
 * with a key printed in a public repository, and looks exactly like one that did.
 */
const PLACEHOLDER_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function keyEncryptionKey(environment: Environment): string {
  const value = required(environment, "KEY_ENCRYPTION_KEY");
  const decoded = Buffer.from(value, "base64");

  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new Error("KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }

  /**
   * Refused in production, warned everywhere else. The placeholder is convenient locally and public
   * in any deployment.
   */
  if (value === PLACEHOLDER_KEY) {
    if (environment.NODE_ENV === "production") {
      throw new Error(
        "KEY_ENCRYPTION_KEY is still the example key from .env.example, which is public. Generate one with: openssl rand -base64 32",
      );
    }
    console.warn(
      "KEY_ENCRYPTION_KEY is the example key from .env.example, which is public. Fine locally. Generate a real one before deploying: openssl rand -base64 32",
    );
  }

  return value;
}

function url(environment: Environment, name: string): string | undefined {
  const value = optional(environment, name);
  if (!value) {
    return undefined;
  }

  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  return value;
}

function optionalHttpUrl(
  environment: Environment,
  name: string,
): URL | undefined {
  const value = optional(environment, name);
  if (!value) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }

  return parsed;
}

/**
 * The Bot in the box, if this deployment has one.
 *
 * A URL with no token would send unauthenticated calls to a Bot that refuses them, so that half
 * alone refuses to start. A token with no URL is the leftover `scripts/start.sh` writes into
 * `.env`; it names nothing and is ignored, so a one-container image can boot from that file.
 */
function managedAgentConfig(
  environment: Environment,
): ManagedAgentConfig | undefined {
  const endpoint = optionalHttpUrl(environment, "MANAGED_AGENT_AG_UI_URL");
  const token = optional(environment, "MANAGED_AGENT_TOKEN");
  if (endpoint && !token) {
    throw new Error(
      "MANAGED_AGENT_TOKEN must be set when MANAGED_AGENT_AG_UI_URL is set",
    );
  }
  if (!endpoint || !token) {
    return undefined;
  }
  return { endpoint, token };
}

function oauthClient(
  environment: Environment,
  provider: "GOOGLE" | "MICROSOFT" | "OKTA",
): OAuthClient | undefined {
  const clientId = optional(environment, `${provider}_OAUTH_CLIENT_ID`);
  const clientSecret = optional(environment, `${provider}_OAUTH_CLIENT_SECRET`);

  // Both or neither. One alone is a half-configured sign-in that fails at the first attempt rather
  // than at start-up, which is the worst moment to discover it.
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      `${provider}_OAUTH_CLIENT_ID and ${provider}_OAUTH_CLIENT_SECRET must be set together`,
    );
  }

  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function commaSeparated(environment: Environment, name: string): string[] {
  return (optional(environment, name) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Sign-in, if this deployment has an identity provider to sign people in with.
 *
 * Any one of the three turns authentication on. More than one is allowed and is the normal shape
 * for a company mid-migration, where some people are on Entra and some are still on Okta.
 *
 * Every combination that cannot work refuses at start-up rather than at somebody's first attempt to
 * sign in, which is the worst moment to discover it: a provider with half its credentials, a
 * provider with no session secret to mint against, or a session secret configured with no provider
 * to use it.
 */
function authConfig(
  environment: Environment,
  google: OAuthClient | undefined,
): AuthConfig | undefined {
  const microsoft = microsoftAuth(environment);
  const okta = oktaAuth(environment);

  const secret = optional(environment, "BETTER_AUTH_SECRET");
  const baseUrl = url(environment, "BETTER_AUTH_URL");

  if (!google && !microsoft && !okta) {
    if (secret || baseUrl) {
      throw new Error(
        "BETTER_AUTH_SECRET or BETTER_AUTH_URL is set but no identity provider is. Configure GOOGLE_OAUTH_*, MICROSOFT_OAUTH_* or OKTA_OAUTH_*, or unset both",
      );
    }
    return undefined;
  }
  if (!secret) {
    throw new Error("Sign-in requires BETTER_AUTH_SECRET");
  }
  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }
  if (!baseUrl) {
    throw new Error("Sign-in requires BETTER_AUTH_URL");
  }

  /*
   * Somebody has to be an administrator, and only this says who.
   *
   * The role is written from this list and there is no route anywhere that changes one, so a
   * deployment that configures sign-in without it admits everybody as a plain user, shows nobody
   * the admin screens, and offers no way to promote anyone. Refusing at start-up is the only cheap
   * moment to catch that; the expensive one is after the first person has signed in.
   */
  const initialAdminEmails = commaSeparated(
    environment,
    "INITIAL_ADMIN_EMAILS",
  );
  if (initialAdminEmails.length === 0) {
    throw new Error(
      "Sign-in requires INITIAL_ADMIN_EMAILS naming at least one administrator. Nothing else grants the role, and no screen can promote somebody once the deployment is running",
    );
  }

  return {
    baseUrl,
    secret,
    trustedOrigins: commaSeparated(environment, "TRUSTED_ORIGINS").length
      ? commaSeparated(environment, "TRUSTED_ORIGINS")
      : ["http://localhost:3010"],
    initialAdminEmails,
    ...(google ? { google } : {}),
    ...(microsoft ? { microsoft } : {}),
    ...(okta ? { okta } : {}),
  };
}

/**
 * Entra ID, and which directory it admits.
 *
 * `common` by default, matching Microsoft's own default, and said out loud in `.env.example` because
 * it admits personal Microsoft accounts as well as work ones. A company that means "our staff"
 * wants its directory GUID here.
 */
function microsoftAuth(
  environment: Environment,
): (OAuthClient & { tenantId: string }) | undefined {
  const client = oauthClient(environment, "MICROSOFT");
  if (!client) return undefined;
  return {
    ...client,
    tenantId: optional(environment, "MICROSOFT_OAUTH_TENANT_ID") ?? "common",
  };
}

/**
 * Okta, which is an OIDC provider rather than a named one.
 *
 * The issuer is what makes it a particular Okta rather than Okta in general, so it is required
 * alongside the credentials rather than defaulted to anything.
 */
function oktaAuth(
  environment: Environment,
): (OAuthClient & { issuer: string }) | undefined {
  const client = oauthClient(environment, "OKTA");
  const issuer = url(environment, "OKTA_OAUTH_ISSUER");
  if (!client) {
    if (issuer) {
      throw new Error(
        "OKTA_OAUTH_ISSUER is set but OKTA_OAUTH_CLIENT_ID and OKTA_OAUTH_CLIENT_SECRET are not",
      );
    }
    return undefined;
  }
  if (!issuer) {
    throw new Error(
      "Okta sign-in requires OKTA_OAUTH_ISSUER, such as https://example.okta.com/oauth2/default",
    );
  }
  return { ...client, issuer };
}

/**
 * Resolve the Intelligence contract, or refuse to start.
 *
 * All four values are required together. A partial set is the more dangerous shape than none at all:
 * it means somebody intended to configure Intelligence and got it wrong, so failing on the partial
 * set alone (as this did) let a completely unconfigured deployment through as if that were a choice.
 */
function runtimeCapabilities(environment: Environment): RuntimeCapabilities {
  const settings = {
    apiUrl: url(environment, "INTELLIGENCE_API_URL"),
    gatewayWsUrl: url(environment, "INTELLIGENCE_GATEWAY_WS_URL"),
    apiKey: optional(environment, "INTELLIGENCE_API_KEY"),
    licenseToken: optional(environment, "COPILOTKIT_LICENSE_TOKEN"),
  };

  const missing = Object.entries({
    INTELLIGENCE_API_URL: settings.apiUrl,
    INTELLIGENCE_GATEWAY_WS_URL: settings.gatewayWsUrl,
    INTELLIGENCE_API_KEY: settings.apiKey,
    COPILOTKIT_LICENSE_TOKEN: settings.licenseToken,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `CopilotKit Intelligence is required and is not configured. Missing: ${missing.join(", ")}`,
    );
  }

  return {
    mode: "intelligence",
    durableHistory: true,
    intelligence: settings as IntelligenceSettings,
  };
}

/**
 * Whether a Bot may reach addresses inside this deployment's own network.
 *
 * Off unless asked for, and the asking is only allowed on a laptop. The switch exists so that a
 * local deployment can browse the services running beside it; what it turns off is not one rule but
 * the whole private-address floor, in navigation and in the endpoint a Bot may be registered
 * against, so with it on a signed-in person can point a Bot at a link-local address.
 *
 * Refused in production for the reason the example encryption key is: the way a deployment ends up
 * with it is not forgetting to set something, it is copying `.env.example`, which shipped it on. The
 * cloud metadata addresses are refused underneath this either way — see `computer/target.ts` — but
 * that floor is the last one, not the only one worth keeping.
 */
/**
 * The private addresses this deployment will let an agent be registered at.
 *
 * A comma-separated list of hosts, each optionally with a port: `agents.internal`,
 * `10.0.0.42:9000`. Matching is exact, so a name with a port pins that port and a name without one
 * covers any port on that host. No suffixes and no wildcards, because a pattern that widens by
 * accident is the usual way a host check fails, and naming three addresses is not onerous.
 *
 * A scheme or a path is a mistake worth catching here rather than at the first registration that
 * silently never matches, so both are refused with the offending entry named.
 */
function agentEndpointAllowedHosts(
  environment: NodeJS.ProcessEnv,
): ReadonlySet<string> {
  const named = commaSeparated(environment, "AGENT_ENDPOINT_ALLOWED_HOSTS");
  const hosts = new Set<string>();
  for (const entry of named) {
    const host = entry.trim().toLowerCase();
    if (!host) continue;
    if (host.includes("/") || host.includes("://")) {
      throw new Error(
        `AGENT_ENDPOINT_ALLOWED_HOSTS entry "${entry}" must be a host, optionally with a port, and not a URL.`,
      );
    }
    if (host.includes("*")) {
      throw new Error(
        `AGENT_ENDPOINT_ALLOWED_HOSTS entry "${entry}" must name one host. Patterns are not accepted: list each address instead.`,
      );
    }
    hosts.add(host.replace(/^\[/, "").replace(/\]$/, ""));
  }
  return hosts;
}

function privateHostsAllowed(environment: Environment): boolean {
  if (optional(environment, "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS") !== "true") {
    return false;
  }

  // Through `optional`, so the comparison trims. Read raw, `NODE_ENV="production "` out of an env
  // file would slip past a gate that the switch beside it, which does trim, would still trip.
  if (optional(environment, "NODE_ENV") === "production") {
    throw new Error(
      "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true is for local development only: it lets a Bot reach this deployment's own network. Remove it from this deployment's environment.",
    );
  }
  console.warn(
    "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true lets a Bot reach this machine's own services. Fine locally, and for local development only. Remove it before deploying.",
  );

  return true;
}

/**
 * A duration a person would write, as milliseconds.
 *
 * `30m` rather than `1800000`, because this one is read and edited by whoever is deciding how long a
 * computer may sit idle, and a wrong number of zeroes there is either a computer that never sleeps
 * or one that vanishes mid-task. Plain digits are still milliseconds, so anything already set keeps
 * its meaning.
 */
export function durationMs(value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h)?$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `"${value}" is not a duration. Write it as 30s, 30m, 2h, or a plain number of milliseconds.`,
    );
  }
  const amount = Number(match[1]);
  switch (match[2]) {
    case "h":
      return amount * 3_600_000;
    case "m":
      return amount * 60_000;
    case "s":
      return amount * 1_000;
    default:
      return amount;
  }
}

function computerConfig(environment: Environment): ComputerConfig | undefined {
  const supervisorAddress = optional(environment, "COMPUTER_SUPERVISOR_URL");
  const sharedAddress = optional(environment, "AGENT_COMPUTER_URL");
  const sandboxNamespace = optional(environment, "COMPUTER_SANDBOX_NAMESPACE");
  if (!supervisorAddress && !sharedAddress && !sandboxNamespace) {
    return undefined;
  }

  /*
   * The secret the computers require. Without it every call to a computer is refused, and that is the
   * intended failure: `agent-computer` drives a browser holding real logins and must not answer
   * unauthenticated callers that can reach its port.
   */
  const computerToken = optional(environment, "COMPUTER_TOKEN");

  const allowPrivateHosts = privateHostsAllowed(environment);
  const policy = actionPolicy(environment);

  /*
   * Checked before the other two, because a deployment that named a namespace means the cluster to
   * make the computers, and a stray `AGENT_COMPUTER_URL` left in an environment would otherwise
   * quietly put every Bot back on one shared browser.
   */
  if (sandboxNamespace) {
    return {
      provider: "sandbox",
      namespace: sandboxNamespace,
      idleAfterMs: durationMs(
        optional(environment, "COMPUTER_SANDBOX_IDLE_AFTER") ?? "30m",
      ),
      templateFile:
        optional(environment, "COMPUTER_SANDBOX_TEMPLATE_FILE") ??
        "/etc/openbot/sandbox-template.json",
      allowPrivateHosts,
      ...(computerToken ? { token: computerToken } : {}),
      ...(policy ? { policy } : {}),
    };
  }

  const supervisorUrl = url(environment, "COMPUTER_SUPERVISOR_URL");
  if (supervisorUrl) {
    const supervisorToken = optional(environment, "SUPERVISOR_TOKEN");
    return {
      provider: "docker",
      baseUrl: supervisorUrl,
      allowPrivateHosts,
      ...(supervisorToken ? { supervisorToken } : {}),
      ...(computerToken ? { token: computerToken } : {}),
      ...(policy ? { policy } : {}),
    };
  }

  const baseUrl = url(environment, "AGENT_COMPUTER_URL");
  if (!baseUrl) {
    return undefined;
  }

  return {
    provider: "shared",
    baseUrl,
    allowPrivateHosts,
    ...(computerToken ? { token: computerToken } : {}),
    ...(policy ? { policy } : {}),
  };
}

/**
 * The action policy, as JSON in one variable.
 *
 * Refuses to start on malformed JSON or a policy of the wrong shape, rather than falling back to the
 * default. An operator who wrote a rule and mistyped it would otherwise get a running deployment that
 * silently permits what they had just tried to forbid, and no indication that anything was wrong.
 * Configuration the product cannot honour belongs at the boot boundary; see the note at the top.
 */
function actionPolicy(environment: Environment): ActionPolicy | undefined {
  const raw = optional(environment, "AGENT_COMPUTER_POLICY");
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_COMPUTER_POLICY must be valid JSON");
  }

  const result = parseActionPolicy(parsed);
  if (!result.ok) {
    throw new Error(`AGENT_COMPUTER_POLICY is invalid: ${result.error}`);
  }
  return result.policy;
}

/**
 * How long silence on a Bot's stream is allowed to last.
 *
 * Refuses to start on anything that is not a whole number of milliseconds, rather than falling back
 * to the default. Same reasoning as the action policy above it: an operator who meant to write a
 * two-minute timeout and typed something else would otherwise get a running deployment with a
 * silently different boundary, and no indication that anything was wrong.
 *
 * Zero is a legitimate value and means off. It is not the same as a malformed one.
 */
function accessibilityEnabled(environment: Environment): boolean {
  const off = optional(environment, "OPENBOT_ACCESSIBILITY_DISABLED");
  return off !== "true" && off !== "1";
}

/**
 * Whether a Bot may draw an interface it wrote itself.
 *
 * ASKED FOR, NOT INHERITED, which is the one place this deliberately breaks the symmetry with
 * OPENBOT_ACCESSIBILITY_DISABLED above it. That flag names a deployment out of an analytics label,
 * so defaulting it on costs a fork nothing it would mind. This one decides whether a model may put
 * code it wrote on somebody's screen and pull libraries from a CDN to run it. Written as a disable
 * switch, absence would be the permissive answer, and a deployment acquires the capability by
 * upgrading rather than by choosing it — which is exactly how a deployment that auto-deploys its
 * default branch would find out.
 *
 * Only "true" or "1" turn it on. Anything else is not a way of saying yes, and a value nobody
 * intended should leave a capability off rather than on.
 *
 * The answer has to reach the browser as well as the runtime, which is why it ends up on
 * /api/capabilities rather than staying server-side. Enabling only the runtime half would leave the
 * browser never offering the tool; enabling only the browser half would have a Bot generate a whole
 * interface that nothing renders. See DeploymentConfig.generativeUi.
 */
function generativeUiEnabled(environment: Environment): boolean {
  const on = optional(environment, "OPENBOT_GENERATIVE_UI");
  return on === "true" || on === "1";
}

/**
 * A port from the environment, or the protocol's default.
 *
 * Refused rather than coerced, the same as every other number in this file. A deployment that typed
 * `993 ` with a stray character and silently got 993 anyway is fine; one that typed `9993` and got
 * the default would be talking to the right host on the wrong port with nothing saying so.
 */
function mailboxPort(
  environment: Environment,
  name: string,
  fallback: number,
): number {
  const raw = optional(environment, name);
  if (!raw) return fallback;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a port number between 1 and 65535`);
  }
  return port;
}

/**
 * The deployment's mailbox, if it has one.
 *
 * Absent when none of the three are set, which is the ordinary state of a deployment that does not
 * want this. Set one or two of them and it refuses to start naming what is missing, rather than
 * booting with half a mailbox: a deployment with a host and no user is one where every mail tool
 * fails at the first login, at run time, in front of somebody, and the only evidence is an auth
 * failure from a server that will not say which half was wrong.
 *
 * The passwords are deliberately not read here. See {@link MailboxConfig}.
 */
function mailboxConfig(environment: Environment): MailboxConfig | undefined {
  const imapHost = optional(environment, "MAILBOX_IMAP_HOST");
  const smtpHost = optional(environment, "MAILBOX_SMTP_HOST");
  const users = mailboxUsers(environment);
  if (!imapHost && !smtpHost && users.length === 0) return undefined;

  const missing = [
    imapHost ? null : "MAILBOX_IMAP_HOST",
    smtpHost ? null : "MAILBOX_SMTP_HOST",
    users.length > 0 ? null : "MAILBOX_USERS",
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(", ")} must be set as well: a mailbox needs an IMAP host, an SMTP host and at least one user. Unset all three to switch the mailbox off.`,
    );
  }

  return {
    imapHost: imapHost as string,
    // Implicit TLS on both, rather than the STARTTLS ports. See MailboxConfig.
    imapPort: mailboxPort(environment, "MAILBOX_IMAP_PORT", 993),
    smtpHost: smtpHost as string,
    smtpPort: mailboxPort(environment, "MAILBOX_SMTP_PORT", 465),
    users,
    allowedRecipientDomains: allowedRecipientDomains(environment),
  };
}

/**
 * The accounts on this deployment's mail hosts, in the order they were written.
 *
 * `MAILBOX_USERS` is the list and its first entry is the default account. `MAILBOX_USER`, the
 * singular this feature shipped with, is still read as a list of one, so a deployment that already
 * has one does not have to be edited to keep working. Both set is refused rather than merged or
 * silently preferred: they are two answers to the same question, and a deployment holding both has
 * an intention nobody here can read.
 *
 * Lower-cased and deduplicated, because an address is case-insensitive and the address is also the
 * key of the vault credential holding that account's password. `Support@` and `support@` written as
 * two entries are one mailbox, and treating them as two would be a second account nothing can ever
 * unlock.
 *
 * An entry that is not an address refuses to start, naming it. It would otherwise become an account
 * a model can select, a credential key an administrator cannot guess, and a login failure at run
 * time in front of somebody.
 */
function mailboxUsers(environment: Environment): string[] {
  const list = optional(environment, "MAILBOX_USERS");
  const legacy = optional(environment, "MAILBOX_USER");
  if (list && legacy) {
    throw new Error(
      "MAILBOX_USERS and MAILBOX_USER are both set and they are the same setting. Keep MAILBOX_USERS, which holds the whole list, and unset MAILBOX_USER.",
    );
  }

  const name = list ? "MAILBOX_USERS" : "MAILBOX_USER";
  const entries = list
    ? commaSeparated(environment, "MAILBOX_USERS")
    : legacy
      ? [legacy]
      : [];

  const users: string[] = [];
  for (const entry of entries) {
    if (!/^[^\s@,]+@[^\s@,]+$/.test(entry)) {
      throw new Error(
        `${name} entry "${entry}" must be an email address such as bot@example.com`,
      );
    }
    const address = entry.toLowerCase();
    if (!users.includes(address)) users.push(address);
  }
  return users;
}

/**
 * Where mail from this deployment may go, read from the environment.
 *
 * Unset and empty are the same answer, and it is "anywhere": a deployment that has not said
 * otherwise keeps the behaviour it had, and one that empties the variable has switched the
 * restriction off rather than switched every send off. The opposite reading would turn a blanked
 * line in a `.env` into a mailbox that silently refuses everybody.
 *
 * Lower-cased, because a domain is case-insensitive and an allowlist that misses `Example.test` is
 * an allowlist somebody will debug at the wrong end. A leading `@` is accepted and dropped, since
 * that is how a person writes a domain when they are thinking of addresses.
 *
 * Refused rather than ignored when an entry is not a domain. `MAILBOX_ALLOWED_RECIPIENT_DOMAINS` is
 * a safety list, and one written as `sales@example.test` that silently matched nothing would be a
 * deployment that believes it is restricted and is not.
 */
function allowedRecipientDomains(
  environment: Environment,
): ReadonlySet<string> {
  const domains = commaSeparated(
    environment,
    "MAILBOX_ALLOWED_RECIPIENT_DOMAINS",
  ).map((entry) => entry.replace(/^@/, "").toLowerCase());

  for (const domain of domains) {
    if (
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(
        domain,
      )
    ) {
      throw new Error(
        `MAILBOX_ALLOWED_RECIPIENT_DOMAINS entry "${domain}" must be a domain such as example.com, not an address or a URL`,
      );
    }
  }
  return new Set(domains);
}

/**
 * How long the audit trail is kept.
 *
 * Refused rather than coerced, like everything else here. "We accepted your retention policy but not
 * the one you wrote" is a bad answer about a control an auditor will ask to see, and a typo that
 * silently became 0 would delete the trail rather than keep it.
 */
function auditRetentionDays(environment: Environment): number | undefined {
  const raw = optional(environment, "AUDIT_RETENTION_DAYS");
  if (!raw) return undefined;

  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(
      "AUDIT_RETENTION_DAYS must be a whole number of days, at least 1. Leave it unset to keep the audit trail forever.",
    );
  }
  return days;
}

function agentStallTimeoutMs(environment: Environment): number {
  const raw = optional(environment, "AGENT_STALL_TIMEOUT_MS");
  if (!raw) {
    return 0;
  }

  const milliseconds = Number(raw);
  if (!Number.isInteger(milliseconds) || milliseconds < 0) {
    throw new Error(
      "AGENT_STALL_TIMEOUT_MS must be a whole number of milliseconds, or 0 to switch the watchdog off",
    );
  }
  return milliseconds;
}

export function loadConfig(
  environment: Environment = process.env,
): DeploymentConfig {
  const google = oauthClient(environment, "GOOGLE");
  const auth = authConfig(environment, google);
  const managedAgent = managedAgentConfig(environment);
  const workerSharedSecret = optional(environment, "WORKER_SHARED_SECRET");
  const mailbox = mailboxConfig(environment);

  return {
    databaseUrl: required(environment, "DATABASE_URL"),
    keyEncryptionKey: keyEncryptionKey(environment),
    ...(managedAgent ? { managedAgent } : {}),
    agentEndpointAllowedHosts: agentEndpointAllowedHosts(environment),
    deploymentId: optional(environment, "DEPLOYMENT_ID"),
    publicUrl: (
      optional(environment, "OPENBOT_PUBLIC_URL") ?? auth?.baseUrl
    )?.replace(/\/+$/, ""),
    appUrl: (
      optional(environment, "OPENBOT_APP_URL") ??
      commaSeparated(environment, "TRUSTED_ORIGINS")[0] ??
      optional(environment, "OPENBOT_PUBLIC_URL") ??
      auth?.baseUrl
    )?.replace(/\/+$/, ""),
    tenantPackageDirectory:
      optional(environment, "TENANT_PACKAGE_DIR") ?? "../examples/fintech",
    runtime: runtimeCapabilities(environment),
    agentStallTimeoutMs: agentStallTimeoutMs(environment),
    auditRetentionDays: auditRetentionDays(environment),
    oauth: { google },
    auth,
    singleUser: singleUserEnabled(
      environment,
      configuredAuthProviders(auth).length > 0,
    ),
    accessibility: accessibilityEnabled(environment),
    generativeUi: generativeUiEnabled(environment),
    ...(optional(environment, "APP_DIST_DIR")
      ? { appDistDir: optional(environment, "APP_DIST_DIR") as string }
      : {}),
    computer: computerConfig(environment),
    ...(mailbox ? { mailbox } : {}),
    handoff: handoffCaps(environment),
    ...(optional(environment, "AGENT_TOOL_TOKEN")
      ? { agentToolToken: optional(environment, "AGENT_TOOL_TOKEN") as string }
      : {}),
    ...(workerSharedSecret ? { workerSharedSecret } : {}),
  };
}
