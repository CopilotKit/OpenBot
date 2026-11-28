/*
 * What the fake OpenBot Desktop answers the app's page commands when a scene sets no answer: a Mac
 * that runs OpenBot on this computer, up to date, with a Claude plan. Each value is checked against
 * the type the app reads it as, so a change to the app's type fails `tsc` here.
 * Pattern: app/tests/move-to-cloud-settings.test.tsx (`desktopApp()`).
 */
import type {
  beginPlanSignIn,
  ProviderSignIn,
  prepareAiConnection,
} from "@/lib/ai-connection/desktop";
import type { AiProvider } from "@/lib/ai-connection/providers";
import type {
  DesktopAiConnection,
  DesktopAppUpdate,
  DesktopAppUpdateCheck,
  DesktopStatus,
  DesktopUsageData,
} from "@/lib/desktop/queries";
import type { NotificationPermissionState } from "@/lib/notifications/permission";
import type {
  Answer,
  FallbackAnswer,
} from "../../desktop/src/fakeNative/control";
import {
  HANDBACK_COMMANDS,
  type PageCommand,
} from "../../desktop/src/fakeNative/pageRegistry";

/** What `connection` answers before the app reads it (desktopConnectionQueryOptions). */
type RawConnection = {
  mode?: string;
  address?: string | null;
  moveToCloud?: boolean;
};

/** One row of `ai_providers`, as desktop/src-tauri/src/provider.rs sends it. */
type DesktopProvider = Pick<
  AiProvider,
  "id" | "name" | "summary" | "logins" | "mark"
> & { caution: { says: string; reads_more_at: string } | null };

const MB = 1_000_000;

const STATUS = {
  openbotRunning: true,
  openbotHeld: true,
  processes: [
    { name: "server", memoryBytes: 412 * MB },
    { name: "worker", memoryBytes: 230 * MB },
  ],
  containers: [{ name: "openbot-postgres", memoryBytes: 180 * MB }],
  intelligenceStack: "openbot-intelligence",
  intelligenceContainers: [
    { name: "openbot-intelligence-api", memoryBytes: 310 * MB },
    { name: "openbot-intelligence-db", memoryBytes: 140 * MB },
  ],
  engine: "podman",
  root: "/Users/sam/OpenBot",
  appPort: 3010,
  version: "1.2.0",
  build: "Built 2026-11-21 from main",
  logFolder: "/Users/sam/Library/Logs/ai.copilotkit.openbot.desktop",
} satisfies DesktopStatus;

/** The setup window's list (provider.rs `catalogue()`), in its order and words. */
const PROVIDERS = [
  {
    id: "openai",
    name: "OpenAI",
    summary: "Sign in with ChatGPT Plus, Pro, Team or Enterprise.",
    logins: ["plan", "api-key"],
    mark: "openai",
    caution: null,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    summary: "Sign in with a Claude Pro, Max, Team or Enterprise plan.",
    logins: ["plan", "api-key"],
    mark: "anthropic",
    caution: {
      says: "A Claude plan carries a separate monthly pool of Agent SDK credits. When that pool is empty, Bots stop until it renews or you add API credits.",
      reads_more_at:
        "https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan",
    },
  },
  {
    id: "google",
    name: "Google Gemini",
    summary: "Use a Google AI Studio key or sign in for Gemini API access.",
    logins: ["endpoint", "oauth"],
    mark: "google-color",
    caution: null,
  },
  {
    id: "xai",
    name: "xAI",
    summary: "Use an xAI API key or sign in to your xAI account.",
    logins: ["endpoint", "oauth"],
    mark: "xai",
    caution: null,
  },
  {
    id: "openai-compatible",
    name: "Any OpenAI-compatible endpoint",
    summary: "Azure, Bedrock, Mistral, DeepSeek, Ollama, vLLM or your own.",
    logins: ["endpoint"],
    mark: null,
    caution: null,
  },
] satisfies DesktopProvider[];

const handbacks = Object.fromEntries(
  HANDBACK_COMMANDS.map((command) => [command, null]),
) as Record<(typeof HANDBACK_COMMANDS)[number], null>;

export const PAGE_DEFAULTS: Partial<Record<PageCommand, unknown>> = {
  "plugin:openbot-desktop|record_problem": null,
  "plugin:openbot-desktop|save_logs": null,
  "plugin:openbot-desktop|connection": {
    mode: "local",
    address: null,
    moveToCloud: false,
  } satisfies RawConnection,
  "plugin:openbot-desktop|status": STATUS,
  "plugin:openbot-desktop|update_offer": {
    version: null,
    current: "1.2.0",
    installing: null,
    updatesItself: true,
    ready: null,
  } satisfies DesktopAppUpdate,
  "plugin:openbot-desktop|check_update": {
    found: "upToDate",
    current: "1.2.0",
  } satisfies DesktopAppUpdateCheck,
  "plugin:openbot-desktop|usage_data": {
    shared: true,
    offByEnvironment: false,
  } satisfies DesktopUsageData,
  "plugin:openbot-desktop|ai_connection": {
    kind: "claude-plan",
    model: null,
    endpointHost: null,
  } satisfies DesktopAiConnection,
  "plugin:openbot-desktop|ai_providers": PROVIDERS,
  "plugin:openbot-desktop|begin_plan_sign_in": {
    url: "https://openbot.example.com/plan-sign-in",
  } satisfies Awaited<ReturnType<typeof beginPlanSignIn>>,
  "plugin:openbot-desktop|finish_plan_sign_in": null,
  "plugin:openbot-desktop|cancel_plan_sign_in": null,
  "plugin:openbot-desktop|begin_provider_sign_in": {
    attemptId: "attempt-1",
    url: "https://openbot.example.com/provider-sign-in",
    userCode: "WXYZ-1234",
  } satisfies ProviderSignIn,
  "plugin:openbot-desktop|finish_provider_sign_in": null,
  "plugin:openbot-desktop|cancel_provider_sign_in": null,
  "plugin:openbot-desktop|prepare_ai_connection": {
    ready: true,
  } satisfies Awaited<ReturnType<typeof prepareAiConnection>>,
  "plugin:openbot-desktop|settle_ai_connection": null,
  "plugin:notification|is_permission_granted": true,
  "plugin:notification|request_permission":
    "granted" satisfies NotificationPermissionState,
  "plugin:openbot-desktop|speech_available": "available",
  "plugin:openbot-desktop|appearance": null,
  "plugin:openbot-desktop|zoom": null,
  "plugin:openbot-desktop|notify": null,
  "plugin:openbot-desktop|open_logs": null,
  "plugin:openbot-desktop|restart": null,
  "plugin:openbot-desktop|quit": null,
  "plugin:openbot-desktop|dismiss_update": null,
  "plugin:openbot-desktop|set_organization": null,
  "plugin:openbot-desktop|speech_abort": null,
  "plugin:openbot-desktop|speech_stop": null,
  ...handbacks,
};

export const SCRIPTED: Partial<
  Record<PageCommand, (args: Record<string, unknown> | undefined) => unknown>
> = {
  "plugin:openbot-desktop|intelligence": (args) =>
    args?.action === "status"
      ? { readiness: "ready" }
      : { outcome: "completed" },
  "plugin:openbot-desktop|set_usage_data": (args) =>
    ({
      shared: Boolean(args?.share),
      offByEnvironment: false,
    }) satisfies DesktopUsageData,
};

/** The page commands with no default, and why. */
export const NO_DEFAULT: Readonly<Partial<Record<PageCommand, string>>> = {
  "plugin:openbot-desktop|speech_start": "No scene drives speech yet.",
  "plugin:openbot-desktop|begin_sign_in_redirect":
    "No scene drives a sign-in redirect yet. Refused, the app falls back to a paste or a code.",
  "plugin:openbot-desktop|await_sign_in_redirect":
    "Asked only after begin_sign_in_redirect answers.",
  "plugin:openbot-desktop|cancel_sign_in_redirect":
    "Asked only after begin_sign_in_redirect answers.",
  "plugin:openbot-desktop|install_update":
    "An update moves through update_offer while it installs. A scene sets those answers.",
};

/**
 * The fallback of the shared native control in the app frame: a scripted answer, then a default.
 * Any other command is refused with a string, as Tauri refuses an unknown command.
 */
export function pageFallback(): FallbackAnswer {
  return (command, args) => {
    const scripted = SCRIPTED[command as PageCommand];
    if (scripted) return scripted(args);
    if (command in PAGE_DEFAULTS) return PAGE_DEFAULTS[command as PageCommand];
    throw `command ${command} not found`;
  };
}

/** The answers of a window connected to an OpenBot at `address`. */
export function connectedAnswers(address: string): Record<string, Answer> {
  return {
    "plugin:openbot-desktop|connection": {
      mode: "value",
      value: { mode: "connected", address } satisfies RawConnection,
    },
  };
}
