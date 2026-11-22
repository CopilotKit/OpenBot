/*
 * Settings → General scenes: the AI model row and its dialog, and the Share usage data switch, as
 * OpenBot Desktop shows them to an admin.
 *
 * The AI model row reads the server's AI connection (getAiConnection, aiConnectionQueryOptions in
 * app/src/lib/ai-connection/queries.ts), not Desktop's `ai_connection`: Desktop's answer draws the
 * row only where the server is older than that operation (DesktopAiModelSection). So each scene
 * answers the server's route, and also sets `ai_connection` to the same connection so that both
 * sides agree.
 *
 * A switch goes as connectAi in app/src/lib/ai-connection/mutations.ts runs it in Desktop: an API
 * key needs no `prepare_ai_connection` (only a plan does); the server checks the key and saves it
 * (PUT ai-connection); then Desktop settles to it (`settle_ai_connection`, its default answer). A
 * refusal from the server makes Desktop settle back to the connection the server still reports.
 * The session (../session.ts) answers that no one brings their own AI and that the organization
 * needs no company sign-in, as OpenBot Desktop runs it.
 * Pattern: app/tests/ai-connection-dialog.test.tsx.
 */

import type { AiConnection } from "@/lib/api/generated/model";
import type {
  DesktopAiConnection,
  DesktopUsageData,
} from "@/lib/desktop/queries";
import type { Answer } from "../../../desktop/src/fakeNative/control";
import type {
  ApiAnswer,
  ApiRoute,
  AppRunStep,
  AppScene,
  AppSceneStart,
} from "../../../desktop/workbench/appContract";
import { DEFAULT_SESSION } from "../session";

const AI_CONNECTION_GET =
  "GET /api/v2/organizations/:organizationId/ai-connection" satisfies ApiRoute;
const AI_CONNECTION_PUT =
  "PUT /api/v2/organizations/:organizationId/ai-connection" satisfies ApiRoute;

const AI_CONNECTION_COMMAND = "plugin:openbot-desktop|ai_connection";
const USAGE_DATA_COMMAND = "plugin:openbot-desktop|usage_data";

/** A made-up key. It does not look like a real key of any provider. */
const KEY = "sk-workbench-0000";

/** Sam's organization runs on Sam's Claude plan, which OpenBot Desktop holds. */
const CLAUDE_PLAN = {
  provider: "anthropic",
  login: "plan",
  model: null,
  endpointHost: null,
  keySet: true,
  ready: true,
  source: "stored",
  editable: true,
  saved: [],
  changedAt: "2026-11-05T10:02:47.000Z",
  sharedSignIn: null,
} satisfies AiConnection;

/** After the switch: an OpenAI API key, the one the run types. */
const OPENAI_KEY = {
  ...CLAUDE_PLAN,
  provider: "openai",
  login: "api-key",
  saved: [{ provider: "openai", login: "api-key", endpointHost: null }],
  changedAt: "2026-11-22T09:30:00.000Z",
} satisfies AiConnection;

/**
 * The server's refusal, in the shape of the spec's AiConnectionRefused example
 * (api/openapi.yaml, `keyRefused`), with a made-up sentence in a provider's style.
 */
const KEY_REFUSED = {
  type: "https://open.bot/errors/ai-connection-refused",
  title: "OpenBot couldn't use that connection.",
  status: 422,
  detail: "The provider refused the key: it is not valid.",
  code: "AI_CONNECTION_KEY_REFUSED",
  category: "validation",
  retryable: false,
};

const value = (body: unknown): ApiAnswer => ({ mode: "value", body });

function desktopAnswer(connection: DesktopAiConnection): Answer {
  return { mode: "value", value: connection };
}

/** An admin, so that the AI model row is one they may change, as most installs have it. */
const ADMIN = { ...DEFAULT_SESSION, role: "admin" } as const;

function start(): AppSceneStart {
  return {
    route: "/settings",
    host: "desktop",
    session: ADMIN,
    api: { [AI_CONNECTION_GET]: value(CLAUDE_PLAN) },
    answers: {
      [AI_CONNECTION_COMMAND]: desktopAnswer({
        kind: "claude-plan",
        model: null,
        endpointHost: null,
      }),
    },
  };
}

/**
 * Open the row, choose Change, pick OpenAI, pick its API key tab and type a key: the steps of
 * ai-connection.tsx (AiConnectionRow opens AiConnectionDialog; its "Change" goes to the chooser) and
 * ai-connection-chooser.tsx (ChooseConnection: the "AI provider" list of buttons; in Desktop OpenAI
 * offers "Sign in with my plan" first, so the run picks the "Use an API key" tab; then KeyFields'
 * "OpenAI API key" field). The save is the form's "Connect" button.
 */
function toOpenAiKey(): AppRunStep[] {
  return [
    { at: 1, click: "Anthropic" },
    { at: 2, click: "Change" },
    { at: 3, click: "OpenAI" },
    { at: 4, click: "Use an API key" },
    { at: 5, type: KEY, into: "OpenAI API key" },
  ];
}

const AI_SCENE: AppScene = {
  kind: "app",
  id: "app-settings-ai",
  title: "AI model",
  group: "App: Settings",
  start: start(),
};

/*
 * The switch succeeds: connectAi in mutations.ts sends PUT ai-connection (no prepare for a key),
 * then `settle_ai_connection` (its default answer, null). connectAiMutationOptions' onSuccess reads
 * the connection again, so GET ai-connection then answers the new one, and the chooser shows
 * Connected (ai-connection-chooser.tsx `Connected`). Its "Done" closes the dialog, and the row
 * names OpenAI.
 */
const AI_CHANGE_SCENE: AppScene = {
  kind: "app",
  id: "app-settings-ai-change",
  title: "Change the AI provider",
  group: "App: Settings",
  start: start(),
  run: [
    ...toOpenAiKey(),
    {
      at: 6,
      api: AI_CONNECTION_PUT,
      with: value(OPENAI_KEY),
    },
    { at: 6, api: AI_CONNECTION_GET, with: value(OPENAI_KEY) },
    {
      at: 6,
      answer: AI_CONNECTION_COMMAND,
      with: desktopAnswer({
        kind: "open-ai-api-key",
        model: null,
        endpointHost: null,
      }),
    },
    { at: 6, click: "Connect" },
    { at: 8, click: "Done" },
  ],
};

/*
 * The server refuses the key: PUT ai-connection answers 422 with the provider's sentence, and
 * connectAi throws it; the chooser shows it in its alert (ai-connection-chooser.tsx,
 * `connect.error.message`). Desktop settles back (settleBack in mutations.ts) to the connection that
 * GET ai-connection still reports: the Claude plan. The row under the dialog still says Anthropic.
 */
const AI_REFUSED_SCENE: AppScene = {
  kind: "app",
  id: "app-settings-ai-refused",
  title: "The provider refuses the key",
  group: "App: Settings",
  start: start(),
  run: [
    ...toOpenAiKey(),
    {
      at: 6,
      api: AI_CONNECTION_PUT,
      with: { mode: "fail", status: 422, body: KEY_REFUSED },
    },
    { at: 6, click: "Connect" },
    /*
     * The end. The server still reports the Claude plan: settleBack read it before the chooser
     * showed the refusal. This step changes no answer; it gives the refusal time to show.
     */
    { at: 7, api: AI_CONNECTION_GET, with: value(CLAUDE_PLAN) },
  ],
};

/*
 * usage-data.tsx (UsageDataSection): the "Share usage data" switch calls `set_usage_data` with the
 * new value (setUsageDataMutationOptions), whose scripted answer gives the new state back, and the
 * row draws it.
 */
const USAGE_DATA_SCENE: AppScene = {
  kind: "app",
  id: "app-settings-usage-data",
  title: "Turn off Share usage data",
  group: "App: Settings",
  start: start(),
  run: [
    { at: 2, click: "Share usage data" },
    /*
     * The end. OpenBot Desktop now keeps sharing off, so a later read of `usage_data` agrees. This
     * also gives the switch time to draw its new state.
     */
    {
      at: 3,
      answer: USAGE_DATA_COMMAND,
      with: {
        mode: "value",
        value: {
          shared: false,
          offByEnvironment: false,
        } satisfies DesktopUsageData,
      },
    },
  ],
};

/*
 * usage-data.tsx: with `offByEnvironment` the row says it is turned off on this computer, and the
 * switch is off and disabled.
 */
const USAGE_DATA_LOCKED_SCENE: AppScene = {
  kind: "app",
  id: "app-settings-usage-data-locked",
  title: "Share usage data is off by the environment",
  group: "App: Settings",
  start: {
    ...start(),
    answers: {
      ...start().answers,
      [USAGE_DATA_COMMAND]: {
        mode: "value",
        value: {
          shared: false,
          offByEnvironment: true,
        } satisfies DesktopUsageData,
      },
    },
  },
};

export const SETTINGS_SCENES: readonly AppScene[] = [
  AI_SCENE,
  AI_CHANGE_SCENE,
  AI_REFUSED_SCENE,
  USAGE_DATA_SCENE,
  USAGE_DATA_LOCKED_SCENE,
];
