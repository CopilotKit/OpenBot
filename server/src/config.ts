/**
 * What the runtime can do. There is exactly one answer because CopilotKit Intelligence is required
 * for durable threads and memory. Configuration the product cannot function without belongs at the
 * boot boundary.
 */
import { devAuthEnabled } from "./auth/dev-actor";
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

export type DeploymentConfig = {
  databaseUrl: string;
  keyEncryptionKey: string;
  managedAgentAgUiUrl: URL;
  /**
   * What this deployment calls itself, when more than one shares an Intelligence project.
   *
   * Absent, the tenant package's id stands in, which separates deployments running different
   * packages but not a copy of one running alongside the original. See channels/thread-identity.ts.
   */
  deploymentId: string | undefined;
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
  oauth: {
    google?: { clientId: string; clientSecret: string };
  };
  auth?: {
    baseUrl: string;
    secret: string;
    google: { clientId: string; clientSecret: string };
    trustedOrigins: string[];
    initialAdminEmails: string[];
  };
  /**
   * Local development only: admit everybody as a fixed administrator instead of requiring sign-in.
   * See auth/dev-actor.ts for the two locks that stop this reaching a deployment.
   */
  devNoAuth: boolean;
  /**
   * The Bot computer. Absent means the feature is off and its routes are not mounted, rather than
   * mounted and failing: a capability that is not configured should be missing, not broken.
   */
  computer?: {
    baseUrl: string;
    /** The secret every computer requires of its caller. */
    token?: string;
    /**
     * The container supervisor, when each Bot is to get a computer of its own. Absent means one
     * shared computer at `baseUrl`, which is what a laptop wants and is honest about being one
     * machine.
     */
    supervisor?: { baseUrl: string; token?: string };
    /** True on a laptop, where browsing the deployment's own services is the point. */
    allowPrivateHosts: boolean;
    /**
     * What Bots may do on their computers. Absent means the built-in default applies.
     *
     * A whole policy in one variable rather than a variable per rule, because the rules are an
     * ordered pair of lists and splitting them across `AGENT_COMPUTER_DENY_1`-style names makes their
     * precedence, which is the only subtle thing about them, impossible to see.
     */
    policy?: ActionPolicy;
    /**
     * How long two identical calls count as the same repetition, in milliseconds.
     *
     * Absent uses the built-in window, which assumes a retry loop is a model round trip apart. It is
     * here because that assumption is about someone else's model: a deployment on a slow or heavily
     * queued provider can have genuine retries minutes apart, and there the built-in window counts
     * every attempt as the first one and a rule about repetition never fires at all.
     */
    repeatWindowMs?: number;
  };
  /** Work a Bot does without being asked, and the port another system can ask for it on. */
  routines: RoutineSettings;
};

export type RoutineSettings = {
  /**
   * Whether the clock runs.
   *
   * Off leaves routines writable, listable and runnable by hand, and stops anything firing on its
   * own. That is the shape a second copy of a deployment needs: a developer with a database dump
   * should not have somebody's real routines browsing their real systems at eight o'clock because
   * they restored a backup. Off is a whole-deployment answer rather than a per-routine one for
   * exactly that reason, and it is loud at boot.
   */
  schedulerEnabled: boolean;
  /**
   * Where deliveries arrive.
   *
   * A port of its own, not a path on the API. This is the one surface meant to be reachable by a
   * third party, and the way to keep the rest of the API away from it is for the rest of the API not
   * to be on it; see routines/receiver.ts. Defaults to one above `PORT` so a laptop needs no
   * configuration and two ports are still obviously related.
   */
  webhookPort: number;
  /**
   * What it binds to. 127.0.0.1 unless a deployment says otherwise.
   *
   * The same posture as everything else here: a webhook endpoint reachable from the internet should
   * be a decision somebody made, not one they inherited by starting the server.
   */
  webhookHost: string;
};

type Environment = Record<string, string | undefined>;

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

function requiredHttpUrl(environment: Environment, name: string): URL {
  const value = required(environment, name);

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

function oauthClient(
  environment: Environment,
  provider: "GOOGLE",
): { clientId: string; clientSecret: string } | undefined {
  const clientId = optional(environment, `${provider}_OAUTH_CLIENT_ID`);
  const clientSecret = optional(environment, `${provider}_OAUTH_CLIENT_SECRET`);

  // Both or neither. One alone is a half-configured sign-in that fails at the first attempt rather
  // than at start-up, which is the worst moment to discover it.
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      "Google OAuth configuration requires both client ID and client secret",
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

function authConfig(
  environment: Environment,
  google: { clientId: string; clientSecret: string } | undefined,
): DeploymentConfig["auth"] {
  const secret = optional(environment, "BETTER_AUTH_SECRET");
  const baseUrl = url(environment, "BETTER_AUTH_URL");
  if (!google) {
    if (secret || baseUrl) {
      throw new Error(
        "Google authentication requires GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET",
      );
    }
    return undefined;
  }
  if (!secret) {
    throw new Error("Google authentication requires BETTER_AUTH_SECRET");
  }
  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }
  if (!baseUrl) {
    throw new Error("Google authentication requires BETTER_AUTH_URL");
  }

  return {
    baseUrl,
    secret,
    google,
    trustedOrigins: commaSeparated(environment, "TRUSTED_ORIGINS").length
      ? commaSeparated(environment, "TRUSTED_ORIGINS")
      : ["http://localhost:3000"],
    initialAdminEmails: commaSeparated(environment, "INITIAL_ADMIN_EMAILS"),
  };
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

function computerConfig(
  environment: Environment,
): DeploymentConfig["computer"] {
  const baseUrl = url(environment, "AGENT_COMPUTER_URL");
  if (!baseUrl) {
    return undefined;
  }
  const policy = actionPolicy(environment);
  /*
   * The secret the computers require. Without it every call to a computer is refused, and that is the
   * intended failure: `agent-computer` drives a browser holding real logins and must not answer
   * unauthenticated callers that can reach its port.
   */
  const computerToken = optional(environment, "COMPUTER_TOKEN");
  const supervisorUrl = url(environment, "COMPUTER_SUPERVISOR_URL");
  const supervisorToken = optional(environment, "SUPERVISOR_TOKEN");
  const repeatWindowMs = milliseconds(environment, "COMPUTER_REPEAT_WINDOW_MS");
  return {
    baseUrl,
    allowPrivateHosts:
      optional(environment, "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS") === "true",
    ...(policy ? { policy } : {}),
    ...(repeatWindowMs ? { repeatWindowMs } : {}),
    ...(computerToken ? { token: computerToken } : {}),
    ...(supervisorUrl
      ? {
          supervisor: {
            baseUrl: supervisorUrl,
            ...(supervisorToken ? { token: supervisorToken } : {}),
          },
        }
      : {}),
  };
}

/**
 * A duration in milliseconds, or a refusal to start.
 *
 * Refused rather than quietly defaulted, for the same reason a malformed policy is. An operator who
 * widened a window and typed `3m` would otherwise get a running deployment on the built-in value,
 * and the only evidence would be a rule that never fires, which reads exactly like a Bot behaving
 * itself.
 */
function milliseconds(
  environment: Environment,
  name: string,
): number | undefined {
  const raw = optional(environment, name);
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number of milliseconds`);
  }
  return value;
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
 * The routine settings, with the webhook port defaulting to one above the API's.
 *
 * A bad port refuses to start rather than falling back to the default. An operator who set
 * ROUTINE_WEBHOOK_PORT meant to move the endpoint, and quietly serving it on the port they were
 * moving it off is the one outcome that would surprise them at the worst moment. Same reasoning as
 * the action policy above: configuration the product cannot honour belongs at the boot boundary.
 */
function routineSettings(environment: Environment): RoutineSettings {
  const apiPort = Number.parseInt(environment.PORT ?? "3001", 10);
  const configured = optional(environment, "ROUTINE_WEBHOOK_PORT");
  let webhookPort = (Number.isFinite(apiPort) ? apiPort : 3001) + 1;

  if (configured) {
    const parsed = Number.parseInt(configured, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
      throw new Error("ROUTINE_WEBHOOK_PORT must be a port number");
    }
    webhookPort = parsed;
  }

  const scheduler = optional(environment, "ROUTINE_SCHEDULER") ?? "on";
  if (scheduler !== "on" && scheduler !== "off") {
    throw new Error('ROUTINE_SCHEDULER must be "on" or "off"');
  }

  return {
    schedulerEnabled: scheduler === "on",
    webhookPort,
    webhookHost: optional(environment, "ROUTINE_WEBHOOK_HOST") ?? "127.0.0.1",
  };
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

  return {
    databaseUrl: required(environment, "DATABASE_URL"),
    keyEncryptionKey: keyEncryptionKey(environment),
    managedAgentAgUiUrl: requiredHttpUrl(
      environment,
      "MANAGED_AGENT_AG_UI_URL",
    ),
    deploymentId: optional(environment, "DEPLOYMENT_ID"),
    tenantPackageDirectory:
      optional(environment, "TENANT_PACKAGE_DIR") ?? "../examples/fintech",
    runtime: runtimeCapabilities(environment),
    agentStallTimeoutMs: agentStallTimeoutMs(environment),
    oauth: { google },
    auth: authConfig(environment, google),
    devNoAuth: devAuthEnabled(environment),
    computer: computerConfig(environment),
    routines: routineSettings(environment),
  };
}
