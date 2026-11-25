import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, BrowserType, Page, Request } from "playwright-core";
import { compile } from "tailwindcss";
import { parse } from "yaml";
import type {
  AiConnection,
  AiConnectionProvider,
  PersonalAiConnection,
} from "@/lib/api/generated/model";
import {
  FinishPersonalAiSignInBody,
  FinishPersonalAiSignInResponse,
  GetAiConnectionResponse,
  GetPersonalAiConnectionResponse,
  GetPersonalAiSignInResponse,
  ReplacePersonalAiConnectionBody,
  StartPersonalAiSignInBody,
  StartPersonalAiSignInResponse,
} from "@/lib/api/generated/models/models.zod";
import { ListOrganizationsResponse } from "@/lib/api/generated/organizations/organizations.zod";
import { personBody } from "./accounts-api";

/**
 * Connect your AI, on an OpenBot that provides no AI of its own (OpenBot Cloud).
 *
 * In a real browser, through the app's own signed-in gate (`_authed`), its onboarding route and
 * Settings → General:
 *
 * - A new person whose organization has no AI is held at Connect your AI: its button is disabled,
 *   there is no way past it, and the gate sends them back to it from anywhere in the app. A key the
 *   provider refuses says why; a good one connects, and the button takes them in.
 * - A new person whose organization has an AI never sees the step.
 * - Somebody who finished onboarding before the step existed is sent to it as their only step, and
 *   its button takes them in without finishing onboarding again.
 * - Every provider the server signs in to offers its sign-in first and a key as the alternative,
 *   as the setup window does. xAI, Google and Unbiased AI sign in on their own pages and are read
 *   until approved; a Claude plan finishes with the code Claude's page shows. A ChatGPT plan signs
 *   in with a code first, read until approved like xAI's, with the ChatGPT setting it needs and
 *   its link said before it starts, and again when ChatGPT gives no code. The other way, below
 *   it, finishes with the address ChatGPT sends the browser to.
 *   Failed and expired sign-ins say why and sign in again, and leaving the row stops the reading.
 *   Inside OpenBot Desktop the sign-in is still the server's, never Desktop's.
 * - Inside OpenBot Desktop, Desktop takes a Claude or ChatGPT plan's redirect, so nothing is pasted:
 *   Claude's is sent to Desktop's port and finishes with code#state, ChatGPT's browser sign-in comes
 *   first and finishes with the address it was sent to, and cancelling or leaving stops Desktop
 *   listening. Where Desktop can't listen, the server refuses the port, or the page isn't sent to
 *   Desktop, what the person gets today: Claude's paste, and ChatGPT's code sign-in first.
 * - Use an API key still connects every provider.
 * - Settings shows Your AI: theirs, which can be removed, back to the organization's.
 *
 * The server is served as routes at the API's address, answering as api/openapi.yaml says: the
 * spec's own examples for the person's AI connection, every body the page sends checked against the
 * generated request schema, every answer against the response schema.
 *
 *   OPENBOT_APP_BROWSER=1 bun test app/tests/connect-your-ai.test.tsx
 *
 * Chromium by default, as CI has it. With OPENBOT_APP_SHOTS=<dir> each screen is saved as
 * connect-ai-<screen>-<engine>-<theme>-<width>.png, beside onboarding's Welcome and Settings' AI
 * connection dialog from before.
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const shots = process.env.OPENBOT_APP_SHOTS;
const engines = (process.env.OPENBOT_APP_ENGINES ?? "chromium")
  .split(",")
  .map((engine) => engine.trim())
  .filter((engine) => engine === "chromium" || engine === "webkit") as (
  | "chromium"
  | "webkit"
)[];

const APP = join(import.meta.dir, "..");
/** On https, as OpenBot Cloud is: the page is a secure context, so the clipboard is offered. */
const ORIGIN = "https://openbot.test";
const ORGANIZATION = "/api/v2/organizations/default";
const ME = `${ORGANIZATION}/people/me`;
const PERSONAL = `${ME}/ai-connection`;
const SIGN_INS = `${PERSONAL}/sign-ins`;

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];
type Window = { width: number; height: number };

type Example = { value: Record<string, unknown> };
const spec = parse(
  readFileSync(join(APP, "..", "api", "openapi.yaml"), "utf8"),
) as {
  components: {
    examples: Record<string, Example>;
    responses: Record<
      string,
      {
        content: {
          "application/problem+json": { examples: Record<string, Example> };
        };
      }
    >;
  };
};
/** One of the spec's examples, as the server would send it. */
function example(name: string): Record<string, unknown> {
  const found = spec.components.examples[name]?.value;
  if (!found) throw new Error(`the spec has no ${name} example`);
  return structuredClone(found);
}
const REFUSED =
  spec.components.responses.AiConnectionRefused?.content[
    "application/problem+json"
  ].examples.keyRefused?.value;
if (!REFUSED) throw new Error("the spec has no keyRefused example");
const UNREACHABLE =
  spec.components.responses.AiConnectionRefused?.content[
    "application/problem+json"
  ].examples.unreachable?.value;
if (!UNREACHABLE) throw new Error("the spec has no unreachable example");

const GOOD_KEY = "sk-ant-api03-good";
const BAD_KEY = "sk-ant-api03-refused";

type Start = "none" | "organization";

/**
 * The person's AI connection as the spec's example for `start` says it, on a server set up for
 * Google's sign-in as well (the examples' server is not, so lists the other four).
 */
function personalFor(start: Start): PersonalAiConnection {
  const found = example(
    start === "none"
      ? "PersonalAiConnectionNoneExample"
      : "PersonalAiConnectionOrganizationExample",
  ) as { signIns: string[] };
  return GetPersonalAiConnectionResponse.parse({
    ...found,
    signIns: [...found.signIns, "google"],
  }) as PersonalAiConnection;
}

/** How a sign-in the server runs ends: `never` stays pending for as long as it is read. */
type Outcome = "approved" | "failed" | "expired" | "never";
type SignIn = {
  id: string;
  provider: AiConnectionProvider;
  outcome: Outcome;
  reads: number;
};

/**
 * A sign-in as the server starts it for each provider: the spec's own examples for ChatGPT (in the
 * browser, or with a code when `method` is device), Claude and Unbiased AI, and for xAI and Google
 * the shape of ChatGPT's code sign-in with what their pages give. Both finish by themselves (poll):
 * xAI's device page asks for the code shown here, and Google's page sends the person back to
 * OpenBot, with no code at all.
 */
function signInStarted(
  provider: AiConnectionProvider,
  method: "browser" | "device" | undefined,
) {
  if (provider === "openai")
    return example(
      method === "device"
        ? "AiSignInChatGptExample"
        : "AiSignInChatGptBrowserExample",
    );
  if (provider === "anthropic") return example("AiSignInClaudeExample");
  if (provider === "xai")
    return {
      ...example("AiSignInChatGptExample"),
      id: "eGFpLXNpZ24taW4",
      provider,
      url: "https://accounts.x.ai/oauth2/device?user_code=MQ7T-WD4X",
      userCode: "MQ7T-WD4X",
    };
  if (provider === "google")
    return {
      ...example("AiSignInChatGptExample"),
      id: "Z29vZ2xlLXNpZ24taW4",
      provider,
      url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=example&redirect_uri=https%3A%2F%2Fopenbot.test%2Fapi%2Fexample-callback&response_type=code&state=example",
      userCode: null,
    };
  return example("AiSignInExample");
}

/** What finishes Claude's sign-in: the spec's example of the code Claude's page shows. */
const CLAUDE_CODE = "Zm9vYmFyLWNvZGU#c3RhdGUtZXhhbXBsZQ";

/**
 * Claude's sign-in inside OpenBot Desktop: the port Desktop listens on, and the page the server
 * opens with it, sending Claude's redirect to Desktop with the state CLAUDE_CODE carries. Its code
 * arrives at Desktop, and the app sends it on as code#state: CLAUDE_CODE, nothing pasted.
 */
const DESKTOP_PORT = 53682;
const CLAUDE_REDIRECT_CODE = "Zm9vYmFyLWNvZGU";
const CLAUDE_REDIRECT_STATE = "c3RhdGUtZXhhbXBsZQ";
function claudeLoopbackPage(port: number): string {
  const url = new URL(String(example("AiSignInClaudeExample").url));
  // Claude's code page is asked for with code=true; a redirect to Desktop is not.
  url.searchParams.delete("code");
  url.searchParams.set("redirect_uri", `http://localhost:${port}/callback`);
  url.searchParams.set("state", CLAUDE_REDIRECT_STATE);
  return url.toString();
}
/** What finishes ChatGPT's browser sign-in inside Desktop: the address built from what arrived. */
const CHATGPT_REDIRECT_ADDRESS =
  "http://localhost:1455/auth/callback?code=ac_ZXhhbXBsZS1jb2Rl&state=example";
/**
 * What finishes ChatGPT's sign-in in the browser: the address ChatGPT sends the browser to once the
 * person approves, on the redirect the spec's example asks for, with its state.
 */
const CHATGPT_ADDRESS =
  "http://localhost:1455/auth/callback?code=ac_ZXhhbXBsZS1jb2Rl&scope=openid+profile+email+offline_access&state=example";
const GOOD_CODES: Partial<Record<AiConnectionProvider, string>> = {
  anthropic: CLAUDE_CODE,
};
/** The code inside CHATGPT_ADDRESS, and the state the spec's example sign-in started with. */
const CHATGPT_CODE = "ac_ZXhhbXBsZS1jb2Rl";
const CHATGPT_STATE = "example";

/**
 * The server's sentences for a ChatGPT paste it can't use. A paste from another sign-in, or with no
 * code in it, is refused (400) and the sign-in waits on; one ChatGPT sent back with an error ends it.
 */
const CHATGPT_OTHER_SIGN_IN =
  "That address is from another sign-in. Paste the address from the newest ChatGPT sign-in, or sign in again.";
const CHATGPT_NO_CODE =
  "That address has no sign-in code in it. Approve the sign-in at ChatGPT, then paste the whole address your browser went to.";
const CHATGPT_NOT_APPROVED =
  "The ChatGPT sign-in was not approved. Sign in again.";
/** The server's sentence when OpenAI gives it no code for ChatGPT's code sign-in. */
const CHATGPT_NO_START = "OpenBot could not start the sign-in with OpenAI.";
/** What the person reads then: the setting that is most likely off. */
const CHATGPT_DEVICE_OFF =
  "ChatGPT didn't give OpenBot a code. Device code sign-in is probably turned off. Turn it on in ChatGPT's security settings, then try again.";
/** ChatGPT's security settings, as OpenAI's help center links to them. */
const CHATGPT_SECURITY_SETTINGS = "https://chatgpt.com/#settings/Security";

/**
 * What the server reads from a ChatGPT paste, as it reads it: the whole address, its query alone,
 * or just the code, with the whitespace around it ignored.
 */
function chatGptPaste(pasted: string) {
  const given = pasted.trim();
  let query: URLSearchParams | null = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(given))
    query = new URL(given).searchParams;
  else if (given.includes("?"))
    query = new URLSearchParams(given.slice(given.indexOf("?") + 1));
  else if (/(^|&)(code|state|error)=/.test(given))
    query = new URLSearchParams(given);
  if (!query) return { code: given || null, state: null, error: null };
  const field = (name: string) => query.get(name)?.trim() || null;
  return { code: field("code"), state: field("state"), error: field("error") };
}

/** A refusal in the spec's problem shape, as the server answers a 400. */
function invalid(detail: string) {
  return {
    status: 400,
    json: {
      type: "https://open.bot/errors/validation-error",
      title: "Request validation failed.",
      status: 400,
      detail,
      code: "VALIDATION_ERROR",
      category: "validation",
      retryable: false,
    },
  };
}
/** What the server's sentences call each sign-in. */
const SIGN_IN_NAMES: Record<string, string> = {
  anthropic: "Claude",
  google: "Google",
  openai: "ChatGPT",
  xai: "xAI",
  unbiased: "Unbiased AI",
};

/** Where a sign-in stands, in the spec's shape, with the server's sentence when it is over. */
function signInStatus(
  signIn: SignIn,
  status: "pending" | "approved" | "failed" | "expired",
) {
  const name = SIGN_IN_NAMES[signIn.provider];
  return GetPersonalAiSignInResponse.parse({
    ...example(
      status === "approved"
        ? "AiSignInApprovedExample"
        : "AiSignInPendingExample",
    ),
    id: signIn.id,
    provider: signIn.provider,
    status,
    detail:
      status === "failed"
        ? `${name} didn't approve the sign-in. Sign in again.`
        : status === "expired"
          ? `The ${name} sign-in expired. Sign in again.`
          : null,
    interval: 1,
  });
}

/**
 * The organization's own AI, as an admin reads it, agreeing with what the person's answer says of
 * it: none on OpenBot Cloud until one is set.
 */
function organizationAi(personal: PersonalAiConnection) {
  const organization: AiConnection = {
    provider: personal.organization.provider,
    login: personal.organization.provider ? "api-key" : null,
    model: null,
    endpointHost: null,
    keySet: personal.organization.ready,
    ready: personal.organization.ready,
    source: personal.organization.ready ? "stored" : "none",
    editable: true,
    saved: [],
    changedAt: null,
  };
  return GetAiConnectionResponse.parse(organization);
}

/** The other organizations a person can be in, beside `default`, by id, with their names. */
const OTHERS = { acme: "Acme", globex: "Globex" } as const;
type Other = keyof typeof OTHERS;
const isOther = (id: string | undefined): id is Other =>
  id !== undefined && Object.hasOwn(OTHERS, id);

/** One organization, as the person's list of their own answers it. */
function organizationRow(id: string, name: string, active: boolean) {
  return { personal: false, id, slug: id, name, role: "member", active };
}

/** One OpenBot Cloud's server, as far as these screens ask it. */
class FakeServer {
  personal: PersonalAiConnection;
  /**
   * The person's answer in Acme, a second organization they are in, or null when they are in only
   * `default` (the list of their organizations is then not served, as OpenBot with one answers).
   */
  acme: PersonalAiConnection | null = null;
  /** The person's answer in Globex, a third organization, or null when they are not in it. */
  globex: PersonalAiConnection | null = null;
  /** The organization the session works in. */
  active = "default";
  onboarding: { step: number; completedAt: string | null };
  replaces: unknown[] = [];
  removes = 0;
  completes = 0;
  signIns: unknown[] = [];
  signInReads = 0;
  signOuts = 0;
  /** How each sign-in started from now on ends, in order; approved once these run out. */
  outcomes: Outcome[] = [];
  /** The sign-in under way, as the server keeps it. */
  signIn: SignIn | null = null;
  /** Every code sent to finish a sign-in, as its body was checked. */
  finishes: unknown[] = [];
  /** Every page the app opened in a new tab. */
  opened: string[] = [];
  /**
   * OpenAI gives no code for ChatGPT's code sign-in: the server answers its 422 with its own
   * sentence, as it does when OpenAI's device code endpoint refuses.
   */
  deviceOff = false;
  /**
   * How this server takes Desktop's port for Claude (loopbackPort): `takes` sends Claude's redirect
   * there; `refuses` is a server from before the field, whose strict schema answers 400 for a key it
   * doesn't know; `ignores` starts the sign-in as if it weren't sent, with Claude's code page.
   */
  loopback: "takes" | "refuses" | "ignores" = "takes";

  constructor(start: Start, onboarded = false) {
    this.personal = personalFor(start);
    this.onboarding = onboarded
      ? { step: 1, completedAt: "2026-11-01T09:00:00.000Z" }
      : { step: 0, completedAt: null };
  }

  answer(request: Request): { status: number; json: unknown } {
    const url = new URL(request.url());
    const method = request.method();
    // Another organization answers as `default` does, but for the person's AI there.
    const named = /^\/api\/v2\/organizations\/([^/]+)(\/.*)$/.exec(
      url.pathname,
    );
    const other = isOther(named?.[1]) ? named[1] : undefined;
    const there = other ? this[other] : null;
    const path = there && named ? `${ORGANIZATION}${named[2]}` : url.pathname;
    if (there && path === PERSONAL && method === "GET")
      return { status: 200, json: there };
    if (there && path === `${ORGANIZATION}/ai-connection`)
      return { status: 200, json: organizationAi(there) };
    const memberOf = (Object.keys(OTHERS) as Other[]).filter(
      (id) => this[id] !== null,
    );
    if (
      url.pathname === "/api/v2/people/me/organizations" &&
      memberOf.length > 0
    )
      return {
        status: 200,
        json: ListOrganizationsResponse.parse({
          organizations: [
            organizationRow("default", "Default", this.active === "default"),
            ...memberOf.map((id) =>
              organizationRow(id, OTHERS[id], this.active === id),
            ),
          ],
          canCreate: false,
          nextCursor: null,
        }),
      };
    if (url.pathname === "/api/auth/organization/set-active") {
      this.active = (
        request.postDataJSON() as { organizationId: string }
      ).organizationId;
      return { status: 200, json: {} };
    }
    if (url.pathname === "/api/auth/sign-out") {
      this.signOuts += 1;
      return { status: 200, json: { success: true } };
    }
    if (path === PERSONAL && method === "GET")
      return { status: 200, json: this.personal };
    if (path === PERSONAL && method === "PUT") {
      expect(request.headers()["idempotency-key"]?.length ?? 0).toBeGreaterThan(
        0,
      );
      const body = request.postDataJSON() as Record<string, unknown>;
      this.replaces.push(body);
      const input = ReplacePersonalAiConnectionBody.parse(body);
      for (const key of Object.keys(body))
        expect(Object.keys(input)).toContain(key);
      if (input.apiKey === BAD_KEY) return { status: 422, json: REFUSED };
      const host = input.baseUrl ? new URL(input.baseUrl).host : null;
      this.personal = GetPersonalAiConnectionResponse.parse({
        ...this.personal,
        connection: {
          provider: input.provider,
          login: input.login,
          model: input.model ?? null,
          endpointHost: host,
          keySet: true,
          ready: true,
          source: "stored",
          editable: true,
          saved: [
            {
              provider: input.provider,
              login: input.login,
              endpointHost: host,
            },
          ],
          changedAt: "2026-11-21T10:00:00.000Z",
        },
        uses: "personal",
      }) as PersonalAiConnection;
      return { status: 200, json: this.personal };
    }
    if (path === PERSONAL && method === "DELETE") {
      this.removes += 1;
      const none = example("PersonalAiConnectionNoneExample") as {
        connection: unknown;
      };
      this.personal = GetPersonalAiConnectionResponse.parse({
        ...this.personal,
        connection: none.connection,
        uses: this.personal.organization.ready ? "organization" : "none",
      }) as PersonalAiConnection;
      return { status: 200, json: this.personal };
    }
    if (path === SIGN_INS && method === "POST") {
      expect(request.headers()["idempotency-key"]?.length ?? 0).toBeGreaterThan(
        0,
      );
      const sent = request.postDataJSON() as Record<string, unknown>;
      const body = StartPersonalAiSignInBody.parse(sent);
      // As sent: nothing the spec's schema doesn't name.
      for (const key of Object.keys(sent))
        expect(Object.keys(body)).toContain(key);
      this.signIns.push(sent);
      if ("loopbackPort" in sent && this.loopback === "refuses")
        return invalid('Unrecognized key: "loopbackPort"');
      if (
        this.deviceOff &&
        body.provider === "openai" &&
        body.method === "device"
      )
        return {
          status: 422,
          json: { ...UNREACHABLE, detail: CHATGPT_NO_START },
        };
      // The spec's example, read again every second rather than five so the test is quick.
      const begun = StartPersonalAiSignInResponse.parse({
        ...signInStarted(body.provider, body.method),
        ...(body.provider === "anthropic" &&
        body.loopbackPort !== undefined &&
        this.loopback === "takes"
          ? { url: claudeLoopbackPage(body.loopbackPort) }
          : {}),
        interval: 1,
      });
      this.signIn = {
        id: begun.id,
        provider: body.provider,
        outcome: this.outcomes.shift() ?? "approved",
        reads: 0,
      };
      return { status: 201, json: begun };
    }
    if (path.startsWith(`${SIGN_INS}/`) && method === "GET") {
      this.signInReads += 1;
      const signIn = this.signIn;
      if (!signIn || !path.endsWith(`/${signIn.id}`))
        return { status: 404, json: { detail: "No such sign-in." } };
      signIn.reads += 1;
      return {
        status: 200,
        json: signInStatus(
          signIn,
          signIn.reads < 2 || signIn.outcome === "never"
            ? "pending"
            : signIn.outcome,
        ),
      };
    }
    if (
      path.startsWith(`${SIGN_INS}/`) &&
      path.endsWith("/code") &&
      method === "POST"
    ) {
      expect(request.headers()["idempotency-key"]?.length ?? 0).toBeGreaterThan(
        0,
      );
      const body = request.postDataJSON() as Record<string, unknown>;
      const input = FinishPersonalAiSignInBody.parse(body);
      for (const key of Object.keys(body))
        expect(Object.keys(input)).toContain(key);
      this.finishes.push(input);
      const signIn = this.signIn;
      if (!signIn || path !== `${SIGN_INS}/${signIn.id}/code`)
        return { status: 404, json: { detail: "No such sign-in." } };
      if (signIn.provider === "openai") {
        const read = chatGptPaste(input.code);
        if (read.state !== null && read.state !== CHATGPT_STATE)
          return invalid(CHATGPT_OTHER_SIGN_IN);
        if (read.error)
          return {
            status: 200,
            json: FinishPersonalAiSignInResponse.parse({
              ...signInStatus(signIn, "failed"),
              detail: CHATGPT_NOT_APPROVED,
            }),
          };
        if (!read.code) return invalid(CHATGPT_NO_CODE);
        return {
          status: 200,
          json: FinishPersonalAiSignInResponse.parse(
            signInStatus(
              signIn,
              read.code === CHATGPT_CODE ? "approved" : "failed",
            ),
          ),
        };
      }
      const good = GOOD_CODES[signIn.provider];
      return {
        status: 200,
        json: FinishPersonalAiSignInResponse.parse(
          signInStatus(
            signIn,
            good && input.code.trim() === good ? "approved" : "failed",
          ),
        ),
      };
    }
    if (path === ME && method === "GET")
      return {
        status: 200,
        json: {
          person: personBody({
            id: "dana",
            name: "Dana Whitfield",
            email: "dana@example.com",
            role: "admin",
            onboarding: this.onboarding,
          }),
          openbotVersion: "v1.1.3",
        },
      };
    // The name step's save: the name is the one they have, as far as these screens care.
    if (path === ME && method === "PATCH")
      return {
        status: 200,
        json: {
          person: personBody({
            id: "dana",
            name: "Dana Whitfield",
            email: "dana@example.com",
            role: "admin",
            onboarding: this.onboarding,
          }),
        },
      };
    if (path === `${ME}/onboarding/advance` && method === "POST") {
      const { step } = request.postDataJSON() as { step: number };
      this.onboarding = { ...this.onboarding, step };
      return { status: 200, json: { onboarding: this.onboarding } };
    }
    if (path === `${ME}/onboarding/complete` && method === "POST") {
      this.completes += 1;
      this.onboarding = {
        ...this.onboarding,
        completedAt: "2026-11-21T10:05:00.000Z",
      };
      return { status: 200, json: { onboarding: this.onboarding } };
    }
    if (path === `${ORGANIZATION}/ai-connection` && method === "GET")
      return { status: 200, json: organizationAi(this.personal) };
    if (path === `${ORGANIZATION}/deployment`)
      return {
        status: 200,
        json: {
          generativeUi: true,
          selfHostBanner: false,
          localEvaluation: false,
          edition: "team",
          authProviders: [],
          ssoConfigured: false,
          ssoRequired: false,
        },
      };
    if (path === `${ME}/approval-preferences`)
      return {
        status: 200,
        json: {
          enabled: false,
          autoReview: false,
          hostCommands: "ask",
          effectiveHostCommands: "ask",
        },
      };
    if (path === `${ME}/preferences`)
      return {
        status: 200,
        json: {
          messageListEmphasis: "thread",
          selfHostBannerDismissed: false,
          narration: null,
          skin: "openbot",
          proactive: "on",
        },
      };
    return { status: 404, json: { detail: "Not found." } };
  }
}

/** The vendored marks as data URIs, as Vite's `import.meta.glob` hands them to `@/lib/marks`. */
function marksModule(): string {
  const dir = join(APP, "..", "shared", "marks");
  const marks = Object.fromEntries(
    readdirSync(dir)
      .filter((file) => file.endsWith(".svg"))
      .map((file) => [
        file.replace(".svg", ""),
        `data:image/svg+xml;base64,${readFileSync(join(dir, file)).toString("base64")}`,
      ]),
  );
  return `const marks = ${JSON.stringify(marks)}; export const markFor = (id) => (id && marks[id]) || null;`;
}

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "connect-your-ai.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    // The gate's module brings the app behind it, whose chat loads a map library only when a Bot
    // draws a map. Nothing here does.
    external: ["maplibre-gl"],
    plugins: [
      {
        name: "marks",
        setup(build) {
          build.onResolve({ filter: /^@\/lib\/marks$/ }, () => ({
            path: "marks",
            namespace: "marks",
          }));
          build.onLoad({ filter: /.*/, namespace: "marks" }, () => ({
            contents: marksModule(),
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, "bundle failed");
  const script = built.outputs.find((output) => output.kind === "entry-point");
  if (!script) throw new Error("bundle has no entry point");
  return script.text();
}

/** The directory of an installed package, from the app or the repository root. */
function packageDir(name: string): string {
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`no package ${name}`);
  return dir;
}

/** Where `@import "<package>[/<file>]"` lands, by the package's `style` export as Vite reads it. */
function packageStylesheet(id: string): string {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const dir = packageDir(name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const subpath = `.${id.slice(name.length)}`;
  const entry = pkg.exports?.[subpath];
  const file =
    typeof entry === "string"
      ? entry
      : (entry?.style ?? entry?.default ?? pkg.main ?? "index.css");
  return join(dir, file);
}

/** The app's stylesheet, built by Tailwind for these classes, as the app's build does. */
async function stylesheet(classes: string[]): Promise<string> {
  const tailwind = dirname(Bun.resolveSync("tailwindcss/package.json", APP));
  const entry = join(APP, "src", "styles.css");
  const compiler = await compile(readFileSync(entry, "utf8"), {
    base: dirname(entry),
    loadStylesheet: async (id, base) => {
      const path =
        id === "tailwindcss"
          ? join(tailwind, "index.css")
          : id.startsWith(".")
            ? join(base, id)
            : packageStylesheet(id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  return compiler.build(classes);
}

const browsers = new Map<string, Browser>();
let script: string;

beforeAll(async () => {
  if (!asked) return;
  script = await bundle();
  const playwright = await import("playwright-core");
  for (const engine of engines) {
    const type: BrowserType = playwright[engine];
    browsers.set(
      engine,
      // The CI job installs full Chromium without the headless shell.
      await type.launch(engine === "chromium" ? { channel: "chromium" } : {}),
    );
  }
}, 120_000);

afterAll(async () => {
  for (const browser of browsers.values()) await browser.close();
});

/**
 * OpenBot Desktop's window, as the page sees it. `true`: a Desktop from before it could take a
 * sign-in's redirect, answering nothing it is asked. `{ listens }`: one with the redirect commands,
 * answering them as desktop_page does, where `listens: false` can't have a port (one is busy).
 */
type DesktopWindow = boolean | { listens: boolean };

/** What the page asked Desktop for its sign-in's redirect, as the stub recorded it. */
type DesktopCall = { command: string; args: Record<string, unknown> };

/**
 * Desktop's three redirect commands, as desktop_page answers them: begin hands out an attempt and
 * its port (Claude's a free one, ChatGPT's always 1455), await waits for the browser's redirect
 * with that state, cancel ends the wait. The test plays the browser: `__desktopArrive` is the
 * redirect reaching Desktop's listener, with the state the page waits for.
 */
function desktopStub(listens: boolean | null, port: number) {
  type Pending = {
    attemptId: string;
    state: string;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  };
  const shell = window as unknown as Record<string, unknown>;
  const calls: DesktopCall[] = [];
  const pending: Pending[] = [];
  let attempts = 0;
  shell.__desktopCalls = calls;
  shell.__desktopWaiting = () => pending.map((one) => one.state);
  shell.__desktopArrive = (code: string | null, error: string | null) => {
    const one = pending.shift();
    if (!one) throw new Error("nothing waits for a redirect");
    one.resolve({ code, state: one.state, error });
  };
  shell.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command: string, args?: Record<string, unknown>) => {
      const name = command.split("|").pop() ?? command;
      if (listens === null) return null;
      if (!name.endsWith("_sign_in_redirect")) return null;
      calls.push({ command: name, args: { ...args } });
      if (name === "begin_sign_in_redirect") {
        if (!listens)
          throw "OpenBot Desktop couldn't listen for the sign-in. Another app is using its port.";
        attempts += 1;
        return {
          attemptId: `attempt-${attempts}`,
          port: args?.provider === "openai" ? 1455 : port,
        };
      }
      if (name === "await_sign_in_redirect")
        return new Promise((resolve, reject) =>
          pending.push({
            attemptId: String(args?.attemptId),
            state: String(args?.state),
            resolve,
            reject,
          }),
        );
      if (name === "cancel_sign_in_redirect") {
        const at = pending.findIndex(
          (one) => one.attemptId === args?.attemptId,
        );
        if (at >= 0)
          pending.splice(at, 1)[0]?.reject("The sign-in was cancelled.");
      }
      return null;
    },
  };
}

/** The page at `path`, its server answering from `server`; `desktop` puts it in a Desktop window. */
async function open(
  path: string,
  server: FakeServer,
  engine: string,
  theme: Theme,
  window: Window,
  desktop: DesktopWindow = false,
): Promise<Page> {
  const browser = browsers.get(engine);
  if (!browser) throw new Error(`no ${engine}`);
  const page = await browser.newPage({
    viewport: window,
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (error) => console.error(error));
  if (desktop)
    await page.addInitScript(
      `(${desktopStub.toString()})(${
        desktop === true ? "null" : String(desktop.listens)
      }, ${DESKTOP_PORT})`,
    );
  const inter = join(packageDir("@fontsource-variable/inter"), "files");
  // A provider's sign-in page, opened in a new tab: recorded, and never fetched from the provider.
  await page.context().route(
    (url) => url.origin !== ORIGIN,
    (route) => {
      server.opened.push(route.request().url());
      return route.fulfill({ contentType: "text/html", body: "" });
    },
  );
  await page.route(`${ORIGIN}/**`, (route) => {
    const where = new URL(route.request().url()).pathname;
    if (where === "/screens.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    const font = join(inter, where.split("/").pop() ?? "");
    if (where.startsWith("/files/") && existsSync(font))
      return route.fulfill({ path: font });
    if (where.startsWith("/api/")) {
      const { status, json } = server.answer(route.request());
      return route.fulfill({
        status,
        json,
        headers:
          status >= 400 ? { "content-type": "application/problem+json" } : {},
      });
    }
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/screens.js"></script></body></html>`,
    });
  });
  await page.goto(`${ORIGIN}${path}`);
  return page;
}

/** Style the page for every class it draws now: what just opened brings classes of its own. */
async function style(page: Page) {
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll("[class]")].flatMap((element) => [
      ...element.classList,
    ]),
  );
  await page.addStyleTag({ content: await stylesheet([...new Set(classes)]) });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

async function shoot(
  page: Page,
  screen: string,
  engine: string,
  theme: Theme,
  window: Window,
) {
  if (!shots) return;
  await style(page);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({
    path: join(
      shots,
      `connect-ai-${screen}-${engine}-${theme}-${window.width}.png`,
    ),
    fullPage: true,
  });
}

/** What a person would see wrong: sideways scroll, or a control cut off at the side. */
async function measured(page: Page) {
  await style(page);
  return page.evaluate(() => {
    const inside = (rect: DOMRect) =>
      rect.left >= -0.5 && rect.right <= innerWidth + 0.5;
    const cut = [...document.querySelectorAll("button, a, input")]
      .filter((control) => {
        const rect = control.getBoundingClientRect();
        // A switch's or a radio's own input is a 1px box out of sight; its control is what shows.
        return rect.width > 1 && rect.height > 1;
      })
      .filter((control) => !control.matches("[data-sidebar=rail]"))
      .filter((control) => !inside(control.getBoundingClientRect()))
      .map(
        (control) =>
          control.textContent?.trim() ||
          control.getAttribute("aria-label") ||
          control.tagName,
      );
    return { sideways: document.documentElement.scrollWidth > innerWidth, cut };
  });
}

const FINE = { sideways: false, cut: [] };
const primary = (page: Page) => page.locator("[data-onboarding-primary]");

/**
 * Wait for the provider's page the app opened in a new tab: its request reaches the route a moment
 * after the tab opens, and later in WebKit than in Chromium.
 */
async function openedIn(page: Page, server: FakeServer, url: string) {
  for (let tries = 0; !server.opened.includes(url) && tries < 50; tries++)
    await page.waitForTimeout(100);
}

/** Every redirect command the page sent the Desktop stub, in order. */
const desktopCalls = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as Record<string, unknown>)
        .__desktopCalls as DesktopCall[],
  );

/**
 * The provider's redirect reaching Desktop's listener, once the page waits for it: Desktop hands
 * the page its code, or the error the provider sent, with the state the page waits for.
 */
async function arrive(
  page: Page,
  code: string | null,
  error: string | null = null,
) {
  await page.waitForFunction(
    () =>
      (
        (
          window as unknown as Record<string, () => string[]>
        ).__desktopWaiting?.() ?? []
      ).length > 0,
  );
  await page.evaluate(
    ([given, failed]) =>
      (
        window as unknown as Record<
          string,
          (code: string | null, error: string | null) => void
        >
      ).__desktopArrive?.(given ?? null, failed ?? null),
    [code, error] as const,
  );
}
const heading = (page: Page, name: string) =>
  page.getByRole("heading", { level: 1, name }).waitFor();

describe.skipIf(!asked)("Connect your AI on OpenBot Cloud", () => {
  for (const engine of engines)
    test(`a new person is held at Connect your AI until they connect, then goes in, in ${engine}`, async () => {
      const server = new FakeServer("none");
      const page = await open("/", server, engine, "light", WIDE);
      try {
        // The gate sends a new person to onboarding; Welcome first, then Connect your AI.
        await heading(page, "Welcome to OpenBot");
        await page.waitForFunction(
          () =>
            !document
              .querySelector("[data-onboarding-primary]")
              ?.hasAttribute("disabled"),
        );
        await primary(page).click();
        await heading(page, "Connect your AI");
        expect(new URL(page.url()).searchParams.get("step")).toBe("ai");
        expect(await primary(page).isDisabled()).toBe(true);
        // No way past it.
        expect(await page.locator("[data-onboarding-secondary]").count()).toBe(
          0,
        );

        // Anywhere else in the app sends them back to it.
        await page.goto(`${ORIGIN}/settings/providers`);
        await heading(page, "Connect your AI");
        expect(new URL(page.url()).pathname).toBe("/onboarding");

        const chooser = page.locator("[data-ai-chooser]");
        // The plan's sign-in first, which the server runs, and a key as the alternative.
        await chooser.getByRole("button", { name: /^OpenAI/ }).click();
        expect(await chooser.getByRole("tab").allTextContents()).toEqual([
          "Sign in with my plan",
          "Use an API key",
        ]);
        await chooser
          .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
          .waitFor();
        await chooser.getByRole("button", { name: "Back" }).click();

        await chooser.getByRole("button", { name: /^Anthropic/ }).click();
        await chooser.getByRole("tab", { name: "Use an API key" }).click();
        const key = chooser.getByLabel("Anthropic API key");
        await key.fill(BAD_KEY);
        await chooser.getByRole("button", { name: "Connect" }).click();
        const alert = chooser.getByRole("alert");
        await alert.waitFor();
        expect(await alert.textContent()).toBe(
          "Anthropic didn't accept that key. Check it and paste it again.",
        );
        expect(server.personal.uses).toBe("none");
        expect(await primary(page).isDisabled()).toBe(true);

        await key.fill(GOOD_KEY);
        await chooser.getByRole("button", { name: "Connect" }).click();
        await chooser.getByRole("status").waitFor();
        expect(await chooser.textContent()).not.toContain(GOOD_KEY);
        expect(server.replaces).toEqual([
          { provider: "anthropic", login: "api-key", apiKey: BAD_KEY },
          { provider: "anthropic", login: "api-key", apiKey: GOOD_KEY },
        ]);
        expect(await measured(page)).toEqual(FINE);

        // Connected: the step's button is the way in, and it finishes onboarding. In, to where
        // they were headed when the gate sent them back: Settings.
        expect(await primary(page).textContent()).toContain("Get started");
        await primary(page).click();
        await page.waitForURL((url) => url.pathname === "/settings/providers");
        await page.getByRole("heading", { name: "Your AI" }).waitFor();
        expect(server.completes).toBe(1);
      } finally {
        await page.close();
      }
    }, 90_000);

  for (const engine of engines)
    test(`a person whose organization has an AI goes straight in, in ${engine}`, async () => {
      const server = new FakeServer("organization");
      const page = await open("/", server, engine, "light", WIDE);
      try {
        await heading(page, "Welcome to OpenBot");
        // One step: no "Step 1 of 2", no Connect your AI.
        expect(await page.locator("[data-onboarding-steps]").count()).toBe(0);
        await page.waitForFunction(
          () =>
            !document
              .querySelector("[data-onboarding-primary]")
              ?.hasAttribute("disabled"),
        );
        await primary(page).click();
        await page.locator("[data-app-home]").waitFor();
        // And once in, nothing sends them back.
        await page.goto(`${ORIGIN}/settings/providers`);
        await page.getByRole("heading", { name: "Your AI" }).waitFor();
        await page
          .getByRole("button", { name: /Your organization's AI/ })
          .waitFor();
        expect(new URL(page.url()).pathname).toBe("/settings/providers");
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`somebody who finished onboarding before has the step alone, in ${engine}`, async () => {
      const server = new FakeServer("none", true);
      const page = await open(
        "/settings/providers",
        server,
        engine,
        "light",
        WIDE,
      );
      try {
        await heading(page, "Connect your AI");
        expect(await page.locator("[data-onboarding-steps]").count()).toBe(0);
        const chooser = page.locator("[data-ai-chooser]");
        await chooser.getByRole("button", { name: /^Anthropic/ }).click();
        await chooser.getByRole("tab", { name: "Use an API key" }).click();
        await chooser.getByLabel("Anthropic API key").fill(GOOD_KEY);
        await chooser.getByRole("button", { name: "Connect" }).click();
        await chooser.getByRole("status").waitFor();
        await primary(page).click();
        // On to Settings, where they were going when the gate stopped them.
        await page.waitForURL((url) => url.pathname === "/settings/providers");
        await page.getByRole("heading", { name: "Your AI" }).waitFor();
        // Already finished: not finished again, and no place in it saved.
        expect(server.completes).toBe(0);
        expect(server.onboarding.step).toBe(1);
      } finally {
        await page.close();
      }
    }, 60_000);

  /*
   * Reported on 1.2.0-rc.1: after the move to OpenBot Cloud, an app's Reconnect opened OpenBot
   * Cloud, the gate asked for Connect your AI first, and its button then left the person on home,
   * nowhere near the app. Where they were headed is kept through the step, and a reload on it.
   */
  for (const engine of engines)
    test(`an app's Reconnect that meets Connect your AI opens that app once the AI is connected, in ${engine}`, async () => {
      const server = new FakeServer("none", true);
      const page = await open(
        "/connections/gmail",
        server,
        engine,
        "light",
        WIDE,
      );
      try {
        await heading(page, "Connect your AI");
        const asked = new URL(page.url());
        expect(asked.pathname).toBe("/onboarding");
        expect(asked.searchParams.get("step")).toBe("ai");
        expect(asked.searchParams.get("next")).toBe("/connections/gmail");
        await page.reload();
        await heading(page, "Connect your AI");
        const chooser = page.locator("[data-ai-chooser]");
        await chooser.getByRole("button", { name: /^Anthropic/ }).click();
        await chooser.getByRole("tab", { name: "Use an API key" }).click();
        await chooser.getByLabel("Anthropic API key").fill(GOOD_KEY);
        await chooser.getByRole("button", { name: "Connect" }).click();
        await chooser.getByRole("status").waitFor();
        await primary(page).click();
        await page.locator('[data-app-connect="gmail"]').waitFor();
        expect(new URL(page.url()).pathname).toBe("/connections/gmail");
        expect(await page.locator("[data-app-home]").count()).toBe(0);
        expect(server.completes).toBe(0);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`a new person sent to onboarding on their way to an app's page goes on to it at the end, in ${engine}`, async () => {
      const server = new FakeServer("none");
      const page = await open(
        "/connections/gmail",
        server,
        engine,
        "light",
        WIDE,
      );
      try {
        await heading(page, "Welcome to OpenBot");
        expect(new URL(page.url()).searchParams.get("next")).toBe(
          "/connections/gmail",
        );
        await page.waitForFunction(
          () =>
            !document
              .querySelector("[data-onboarding-primary]")
              ?.hasAttribute("disabled"),
        );
        await primary(page).click();
        await heading(page, "Connect your AI");
        expect(new URL(page.url()).searchParams.get("next")).toBe(
          "/connections/gmail",
        );
        const chooser = page.locator("[data-ai-chooser]");
        await chooser.getByRole("button", { name: /^Anthropic/ }).click();
        await chooser.getByRole("tab", { name: "Use an API key" }).click();
        await chooser.getByLabel("Anthropic API key").fill(GOOD_KEY);
        await chooser.getByRole("button", { name: "Connect" }).click();
        await chooser.getByRole("status").waitFor();
        await primary(page).click();
        await page.locator('[data-app-connect="gmail"]').waitFor();
        expect(new URL(page.url()).pathname).toBe("/connections/gmail");
        expect(server.completes).toBe(1);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`an address that isn't a page of OpenBot is never followed out of onboarding, in ${engine}`, async () => {
      const server = new FakeServer("none", true);
      const page = await open(
        `/onboarding?step=ai&next=${encodeURIComponent("//evil.example/x")}`,
        server,
        engine,
        "light",
        WIDE,
      );
      try {
        await heading(page, "Connect your AI");
        expect(new URL(page.url()).searchParams.get("next")).toBe(null);
        const chooser = page.locator("[data-ai-chooser]");
        await chooser.getByRole("button", { name: /^Anthropic/ }).click();
        await chooser.getByRole("tab", { name: "Use an API key" }).click();
        await chooser.getByLabel("Anthropic API key").fill(GOOD_KEY);
        await chooser.getByRole("button", { name: "Connect" }).click();
        await chooser.getByRole("status").waitFor();
        await primary(page).click();
        await page.locator("[data-app-home]").waitFor();
        expect(new URL(page.url()).pathname).toBe("/");
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`inside OpenBot Desktop: the plan and Unbiased AI sign in through the server, in ${engine}`, async () => {
      const server = new FakeServer("none", true);
      const page = await open(
        "/onboarding?step=ai",
        server,
        engine,
        "light",
        WIDE,
        true,
      );
      try {
        await heading(page, "Connect your AI");
        const chooser = page.locator("[data-ai-chooser]");
        // The plan's sign-in is the server's, never Desktop's. This Desktop is from before it
        // could take the sign-in's redirect and answers nothing it is asked: ChatGPT signs in as
        // it does there today, with a code, never the address paste, and still finishes.
        await chooser.getByRole("button", { name: /^OpenAI/ }).click();
        await chooser
          .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
          .click();
        await chooser.getByText("VU3W-87566").waitFor();
        await chooser.getByText("Signed in to OpenAI.").waitFor();
        expect(server.signIns).toEqual([
          { provider: "openai", method: "device" },
        ]);
        expect(
          await chooser.getByLabel("Address from your browser").count(),
        ).toBe(0);
        expect(server.finishes).toEqual([]);
        await chooser.getByRole("button", { name: "Back" }).click();
        server.signIns = [];

        await chooser.getByRole("button", { name: /^Unbiased AI/ }).click();
        // Sign-in first, a key as the alternative.
        expect(await chooser.getByRole("tab").allTextContents()).toEqual([
          "Sign in",
          "Use an API key",
        ]);
        await chooser
          .getByRole("button", {
            name: "Sign in with Unbiased AI",
            exact: true,
          })
          .click();
        await chooser.getByText("BCDF-GHJK").waitFor();
        await chooser
          .getByRole("link", { name: "Open the sign-in page" })
          .waitFor();
        await shoot(page, "sign-in-waiting", engine, "light", WIDE);
        await chooser.getByText("Signed in to Unbiased AI.").waitFor();
        expect(server.signIns).toEqual([{ provider: "unbiased" }]);
        await chooser.getByRole("button", { name: "Connect" }).click();
        await chooser.getByRole("status").waitFor();
        expect(server.replaces).toEqual([
          {
            provider: "unbiased",
            login: "endpoint",
            baseUrl: "https://api.unbiased.ai/v1",
            model: "pareto",
            useSavedKey: true,
          },
        ]);
        expect(await primary(page).isDisabled()).toBe(false);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`inside OpenBot Desktop, a Claude plan finishes with nothing pasted: Desktop takes Claude's redirect, in ${engine}`, async () => {
      const server = new FakeServer("none", true);
      const page = await open(
        "/onboarding?step=ai",
        server,
        engine,
        "light",
        WIDE,
        { listens: true },
      );
      try {
        await heading(page, "Connect your AI");
        const chooser = page.locator("[data-ai-chooser]");
        await chooser.getByRole("button", { name: /^Anthropic/ }).click();
        await chooser
          .getByText(
            "Anthropic opens in your browser. It finishes on its own once you approve.",
          )
          .waitFor();
        await shoot(page, "desktop-claude", engine, "light", WIDE);
        await chooser
          .getByRole("button", { name: "Sign in with Anthropic", exact: true })
          .click();
        await chooser
          .getByText("Waiting for you to approve it in your browser…")
          .waitFor();
        // The server sends Claude's redirect to Desktop's port; that page is opened, and linked.
        const claude = claudeLoopbackPage(DESKTOP_PORT);
        expect(server.signIns).toEqual([
          { provider: "anthropic", loopbackPort: DESKTOP_PORT },
        ]);
        expect(
          await chooser
            .getByRole("link", { name: "Open the sign-in page" })
            .getAttribute("href"),
        ).toBe(claude);
        await openedIn(page, server, claude);
        expect(server.opened).toContain(claude);
        // Nothing to paste: no box, and no word of one.
        expect(await chooser.getByRole("textbox").count()).toBe(0);
        expect(await chooser.textContent()).not.toContain("paste");
        expect(await desktopCalls(page)).toEqual([
          {
            command: "begin_sign_in_redirect",
            args: { provider: "anthropic" },
          },
          {
            command: "await_sign_in_redirect",
            args: { attemptId: "attempt-1", state: CLAUDE_REDIRECT_STATE },
          },
        ]);
        expect(await measured(page)).toEqual(FINE);
        await shoot(page, "desktop-claude-waiting", engine, "light", WIDE);

        // Claude's redirect reaches Desktop: its code and state go on to the server as code#state.
        await arrive(page, CLAUDE_REDIRECT_CODE);
        await chooser.getByText("Signed in to Anthropic.").waitFor();
        expect(server.finishes).toEqual([{ code: CLAUDE_CODE }]);
        expect(server.signInReads).toBe(0);
        expect(await chooser.getByRole("textbox").count()).toBe(0);
        await shoot(page, "desktop-claude-signed-in", engine, "light", WIDE);
        await chooser.getByRole("button", { name: "Connect" }).click();
        await chooser.getByRole("status").waitFor();
        expect(server.replaces).toEqual([
          { provider: "anthropic", login: "plan" },
        ]);
        expect(await primary(page).isDisabled()).toBe(false);
        await shoot(page, "desktop-claude-connected", engine, "light", WIDE);
      } finally {
        await page.close();
      }
    }, 90_000);

  for (const engine of engines)
    test(`inside OpenBot Desktop, Claude declining says so and signs in again, in ${engine}`, async () => {
      const server = new FakeServer("none", true);
      const page = await open(
        "/onboarding?step=ai",
        server,
        engine,
        "light",
        WIDE,
        { listens: true },
      );
      try {
        await heading(page, "Connect your AI");
        const chooser = page.locator("[data-ai-chooser]");
        await chooser.getByRole("button", { name: /^Anthropic/ }).click();
        const signIn = chooser.getByRole("button", {
          name: "Sign in with Anthropic",
          exact: true,
        });
        await signIn.click();
        await arrive(page, null, "access_denied");
        const alert = chooser.getByRole("alert");
        await alert.waitFor();
        expect(await alert.textContent()).toBe(
          "The Claude sign-in wasn't approved. Sign in again.",
        );
        expect(server.finishes).toEqual([]);
        await shoot(page, "desktop-claude-declined", engine, "light", WIDE);
        await signIn.click();
        await arrive(page, CLAUDE_REDIRECT_CODE);
        await chooser.getByText("Signed in to Anthropic.").waitFor();
        expect(server.finishes).toEqual([{ code: CLAUDE_CODE }]);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`inside OpenBot Desktop, ChatGPT's browser sign-in comes first and finishes with nothing pasted, and a code is the other way, in ${engine}`, async () => {
      const server = new FakeServer("none", true);
      const page = await open(
        "/onboarding?step=ai",
        server,
        engine,
        "light",
        WIDE,
        { listens: true },
      );
      try {
        await heading(page, "Connect your AI");
        const chooser = page.locator("[data-ai-chooser]");
        await chooser.getByRole("button", { name: /^OpenAI/ }).click();
        // The browser first, with none of the paste's warnings: its last page loads here.
        await chooser
          .getByText(
            "OpenAI opens in your browser. It finishes on its own once you approve.",
          )
          .waitFor();
        expect(
          await chooser.getByText("This site can't be reached").count(),
        ).toBe(0);
        expect(
          await chooser
            .getByRole("img", { name: /This site can't be reached/ })
            .count(),
        ).toBe(0);
        await chooser
          .getByText(
            "You can also sign in with a code. It needs device code sign-in turned on in ChatGPT.",
          )
          .waitFor();
        await chooser
          .getByRole("button", { name: "Sign in with a code instead" })
          .waitFor();
        expect(await measured(page)).toEqual(FINE);
        await shoot(page, "desktop-chatgpt", engine, "light", WIDE);

        const signIn = chooser.getByRole("button", {
          name: "Sign in with ChatGPT",
          exact: true,
        });
        const waitingLine = chooser.getByText(
          "Waiting for you to approve it in your browser…",
        );
        await signIn.click();
        await waitingLine.waitFor();
        expect(server.signIns).toEqual([
          { provider: "openai", method: "browser" },
        ]);
        expect(await chooser.getByRole("textbox").count()).toBe(0);
        expect(
          await chooser.getByLabel("Address from your browser").count(),
        ).toBe(0);
        expect(await chooser.textContent()).not.toContain("paste");
        expect(await measured(page)).toEqual(FINE);
        await shoot(page, "desktop-chatgpt-waiting", engine, "light", WIDE);

        // Cancel sign-in: Desktop stops listening for it.
        await chooser.getByRole("button", { name: "Cancel sign-in" }).click();
        await signIn.waitFor();
        await signIn.click();
        await waitingLine.waitFor();
        await arrive(page, CHATGPT_CODE);
        await chooser.getByText("Signed in to OpenAI.").waitFor();
        // The whole address, built from what arrived, as a person would have pasted it.
        expect(server.finishes).toEqual([{ code: CHATGPT_REDIRECT_ADDRESS }]);
        expect(await desktopCalls(page)).toEqual([
          { command: "begin_sign_in_redirect", args: { provider: "openai" } },
          {
            command: "await_sign_in_redirect",
            args: { attemptId: "attempt-1", state: CHATGPT_STATE },
          },
          {
            command: "cancel_sign_in_redirect",
            args: { attemptId: "attempt-1" },
          },
          { command: "begin_sign_in_redirect", args: { provider: "openai" } },
          {
            command: "await_sign_in_redirect",
            args: { attemptId: "attempt-2", state: CHATGPT_STATE },
          },
        ]);
        await shoot(page, "desktop-chatgpt-signed-in", engine, "light", WIDE);

        // The code, the other way: its steps, and the browser offered back below it.
        await chooser.getByRole("button", { name: "Back" }).click();
        await chooser.getByRole("button", { name: /^OpenAI/ }).click();
        await chooser
          .getByRole("button", { name: "Sign in with a code instead" })
          .click();
        await chooser
          .getByRole("listitem")
          .filter({ hasText: "Sign in with ChatGPT below to get a code." })
          .waitFor();
        await chooser
          .getByText(
            "Your browser can sign in instead. It finishes on its own once you approve.",
          )
          .waitFor();
        await shoot(page, "desktop-chatgpt-code-way", engine, "light", WIDE);

        // Leaving the row while the browser sign-in waits: Desktop stops listening.
        await chooser
          .getByRole("button", { name: "Sign in with your browser instead" })
          .click();
        await signIn.click();
        await waitingLine.waitFor();
        await chooser.getByRole("button", { name: "Back" }).click();
        await page.waitForFunction(() =>
          (
            (window as unknown as Record<string, unknown>)
              .__desktopCalls as DesktopCall[]
          ).some(
            (call) =>
              call.command === "cancel_sign_in_redirect" &&
              call.args.attemptId === "attempt-3",
          ),
        );
      } finally {
        await page.close();
      }
    }, 90_000);

  for (const engine of engines)
    test(`inside OpenBot Desktop, Claude falls back to today's paste when Desktop can't listen, the server refuses the port, or the page isn't Desktop's, and ChatGPT to its code sign-in, in ${engine}`, async () => {
      const cases: {
        name: string;
        listens: boolean;
        loopback: FakeServer["loopback"];
        signIns: Record<string, unknown>[];
        calls: DesktopCall[];
      }[] = [
        {
          name: "busy",
          listens: false,
          loopback: "takes",
          signIns: [{ provider: "anthropic" }],
          calls: [
            {
              command: "begin_sign_in_redirect",
              args: { provider: "anthropic" },
            },
          ],
        },
        {
          name: "older-server",
          listens: true,
          loopback: "refuses",
          signIns: [
            { provider: "anthropic", loopbackPort: DESKTOP_PORT },
            { provider: "anthropic" },
          ],
          calls: [
            {
              command: "begin_sign_in_redirect",
              args: { provider: "anthropic" },
            },
            {
              command: "cancel_sign_in_redirect",
              args: { attemptId: "attempt-1" },
            },
          ],
        },
        {
          name: "not-desktops",
          listens: true,
          loopback: "ignores",
          signIns: [{ provider: "anthropic", loopbackPort: DESKTOP_PORT }],
          calls: [
            {
              command: "begin_sign_in_redirect",
              args: { provider: "anthropic" },
            },
            {
              command: "cancel_sign_in_redirect",
              args: { attemptId: "attempt-1" },
            },
          ],
        },
      ];
      for (const one of cases) {
        const server = new FakeServer("none", true);
        server.loopback = one.loopback;
        const page = await open(
          "/onboarding?step=ai",
          server,
          engine,
          "light",
          WIDE,
          { listens: one.listens },
        );
        try {
          await heading(page, "Connect your AI");
          const chooser = page.locator("[data-ai-chooser]");
          await chooser.getByRole("button", { name: /^Anthropic/ }).click();
          await chooser
            .getByRole("button", {
              name: "Sign in with Anthropic",
              exact: true,
            })
            .click();
          // Today's paste, exactly as in a browser: Claude's code page, and the box for its code.
          const code = chooser.getByLabel("Code from your browser");
          await code.waitFor();
          await chooser
            .getByText(
              "Anthropic opens in your browser. Approve the request there, then paste the code it shows you.",
            )
            .waitFor();
          expect(
            await chooser
              .getByRole("link", { name: "Open the sign-in page" })
              .getAttribute("href"),
          ).toBe(String(example("AiSignInClaudeExample").url));
          expect(server.signIns).toEqual(one.signIns);
          expect(await desktopCalls(page)).toEqual(one.calls);
          if (one.name === "busy")
            await shoot(page, "desktop-fallback-claude", engine, "light", WIDE);
          await code.fill(CLAUDE_CODE);
          await chooser
            .getByRole("button", { name: "Finish", exact: true })
            .click();
          await chooser.getByText("Signed in to Anthropic.").waitFor();
          expect(server.finishes).toEqual([{ code: CLAUDE_CODE }]);
        } finally {
          await page.close();
        }
      }

      // ChatGPT, where Desktop can't listen: what it does today, its code sign-in first, started at
      // once, with the address paste still the other way. Never the address paste first.
      const server = new FakeServer("none", true);
      // The first code waits, to be seen and cancelled; the next is approved.
      server.outcomes = ["never", "approved"];
      const page = await open(
        "/onboarding?step=ai",
        server,
        engine,
        "light",
        WIDE,
        { listens: false },
      );
      try {
        await heading(page, "Connect your AI");
        const chooser = page.locator("[data-ai-chooser]");
        await chooser.getByRole("button", { name: /^OpenAI/ }).click();
        const signIn = chooser.getByRole("button", {
          name: "Sign in with ChatGPT",
          exact: true,
        });
        await signIn.click();
        await chooser.getByText("VU3W-87566").waitFor();
        await chooser
          .getByText(
            "OpenAI opens in your browser. Enter the code shown here, then approve. It finishes on its own.",
          )
          .waitFor();
        expect(server.signIns).toEqual([
          { provider: "openai", method: "device" },
        ]);
        expect(
          await chooser.getByLabel("Address from your browser").count(),
        ).toBe(0);
        expect(
          await chooser.getByText("This site can't be reached").count(),
        ).toBe(0);
        expect(await desktopCalls(page)).toEqual([
          { command: "begin_sign_in_redirect", args: { provider: "openai" } },
        ]);
        expect(await measured(page)).toEqual(FINE);
        await shoot(page, "desktop-fallback-chatgpt", engine, "light", WIDE);

        // Stopped: today's code steps, with the address paste offered below as the other way.
        await chooser.getByRole("button", { name: "Cancel sign-in" }).click();
        await chooser
          .getByRole("listitem")
          .filter({ hasText: "Sign in with ChatGPT below to get a code." })
          .waitFor();
        await chooser
          .getByText(
            "Can't turn on device code sign-in? Your browser can sign in instead. Its last page won't load, and you paste that page's address here.",
          )
          .waitFor();
        await chooser
          .getByRole("button", { name: "Copy an address instead" })
          .waitFor();
        expect(await measured(page)).toEqual(FINE);
        await shoot(
          page,
          "desktop-fallback-chatgpt-other-way",
          engine,
          "light",
          WIDE,
        );

        // Again: the code straight away, Desktop not asked again, and it finishes.
        await signIn.click();
        await chooser.getByText("Signed in to OpenAI.").waitFor();
        expect(server.signIns).toEqual([
          { provider: "openai", method: "device" },
          { provider: "openai", method: "device" },
        ]);
        expect(server.finishes).toEqual([]);
        expect((await desktopCalls(page)).length).toBe(1);
      } finally {
        await page.close();
      }
    }, 120_000);

  // The sign-in screens inside Desktop and in a plain browser, wide and at a phone's width, to set
  // beside the same screens before Desktop took the redirect.
  test.skipIf(!shots)(
    "screenshots of Claude's and ChatGPT's sign-in, inside Desktop and in a browser",
    async () => {
      for (const engine of engines)
        for (const window of [WIDE, PHONE])
          for (const where of ["desktop", "browser"] as const) {
            const server = new FakeServer("none", true);
            server.outcomes = ["never", "never", "never", "never"];
            const page = await open(
              "/onboarding?step=ai",
              server,
              engine,
              "light",
              window,
              where === "desktop" ? { listens: true } : false,
            );
            try {
              await heading(page, "Connect your AI");
              const chooser = page.locator("[data-ai-chooser]");
              for (const [row, button, name] of [
                [/^Anthropic/, "Sign in with Anthropic", "claude"],
                [/^OpenAI/, "Sign in with ChatGPT", "chatgpt"],
              ] as const) {
                await chooser.getByRole("button", { name: row }).click();
                const signIn = chooser.getByRole("button", {
                  name: button,
                  exact: true,
                });
                await signIn.waitFor();
                expect(await measured(page)).toEqual(FINE);
                await shoot(
                  page,
                  `cmp-${where}-${name}`,
                  engine,
                  "light",
                  window,
                );
                await signIn.click();
                await chooser
                  .getByRole("button", { name: "Cancel sign-in" })
                  .waitFor();
                expect(await measured(page)).toEqual(FINE);
                await shoot(
                  page,
                  `cmp-${where}-${name}-waiting`,
                  engine,
                  "light",
                  window,
                );
                await chooser.getByRole("button", { name: "Back" }).click();
              }
            } finally {
              await page.close();
            }
          }
    },
    300_000,
  );

  for (const engine of engines)
    test(`Settings shows Your AI, and removing it goes back to the organization's, in ${engine}`, async () => {
      const server = new FakeServer("organization", true);
      server.personal = GetPersonalAiConnectionResponse.parse(
        example("PersonalAiConnectionExample"),
      ) as PersonalAiConnection;
      const page = await open(
        "/settings/providers",
        server,
        engine,
        "light",
        WIDE,
      );
      try {
        await page.getByRole("heading", { name: "Your AI" }).waitFor();
        // The admin's section for the organization's AI says it is the organization's.
        await page
          .getByRole("heading", { name: "Organization's AI" })
          .waitFor();
        await page
          .getByRole("button", {
            name: /Anthropic.*Uses your Anthropic API key\./,
          })
          .click();
        const dialog = page.getByRole("dialog");
        await dialog.getByText("Your AI", { exact: true }).waitFor();
        await style(page);
        await dialog.getByRole("button", { name: "Remove" }).click();
        await page
          .getByRole("button", { name: /Your organization's AI/ })
          .waitFor();
        expect(server.removes).toBe(1);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`switching into an organization with no AI sends them to the step at once, in ${engine}`, async () => {
      // Default has an AI for everyone; Acme has none, and the person has none of their own.
      const server = new FakeServer("organization", true);
      server.acme = personalFor("none");
      const page = await open("/", server, engine, "light", WIDE);
      try {
        await page.locator("[data-app-home]").waitFor();
        await page.getByRole("button", { name: "Work in Acme" }).click();
        // No second click: the gate decides again in Acme as soon as the app works there.
        await heading(page, "Connect your AI");
        expect(server.active).toBe("acme");
        expect(new URL(page.url()).searchParams.get("step")).toBe("ai");
        expect(await page.locator("[data-app-home]").count()).toBe(0);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`the step lets them work in another organization of theirs, or sign out, in ${engine}`, async () => {
      // Default has no AI and neither do they; Acme has one for everyone.
      const server = new FakeServer("none", true);
      server.acme = personalFor("organization");
      const page = await open("/", server, engine, "light", WIDE);
      try {
        await heading(page, "Connect your AI");
        // Styled: the way out is drawn beside the words on a desktop and under the chooser on a
        // phone, and the stylesheet is what shows one of them.
        await page.getByText("Signed in as dana@example.com").first().waitFor();
        await style(page);
        await page
          .getByRole("heading", { name: "Or work in another organization" })
          .waitFor();
        // Only the others: Default is where they are.
        const others = page.getByRole("group", {
          name: "Or work in another organization",
        });
        expect(
          await others.locator("[data-slot=item-title]").allTextContents(),
        ).toEqual(["Acme"]);
        await others.getByRole("button", { name: /Acme/ }).click();
        await page.locator("[data-app-home]").waitFor();
        expect(server.active).toBe("acme");
      } finally {
        await page.close();
      }

      // In one organization there is no list, and Sign out is always there.
      const alone = new FakeServer("none", true);
      const single = await open("/", alone, engine, "light", WIDE);
      try {
        await heading(single, "Connect your AI");
        await single
          .getByText("Signed in as dana@example.com")
          .first()
          .waitFor();
        await style(single);
        // One of the two is shown: beside the words here, at a desktop's width.
        expect(
          await single
            .getByText("Signed in as dana@example.com")
            .filter({ visible: true })
            .count(),
        ).toBe(1);
        expect(
          await single
            .getByRole("heading", { name: "Or work in another organization" })
            .count(),
        ).toBe(0);
        await single.getByRole("button", { name: "Sign out" }).click();
        await single.locator("[data-sign-in]").waitFor();
        expect(alone.signOuts).toBe(1);
      } finally {
        await single.close();
      }
    }, 90_000);

  /** Welcome's button, once it can be pressed, and on to Connect your AI with its way out drawn. */
  async function toTheStep(page: Page, other: string) {
    await heading(page, "Welcome to OpenBot");
    await page.waitForFunction(
      () =>
        !document
          .querySelector("[data-onboarding-primary]")
          ?.hasAttribute("disabled"),
    );
    await primary(page).click();
    await heading(page, "Connect your AI");
    await page.getByText(other).first().waitFor();
    // Styled: the way out is drawn beside the words on a desktop, and the stylesheet hides the other.
    await style(page);
    return page.getByRole("group", { name: "Or work in another organization" });
  }

  /*
   * Reported on 1.2.0-rc.2: on Connect your AI, picking another organization skipped the step to the
   * name, its Get started left a blank page, and a reload was back at Connect your AI offering the
   * organization just left. Only an organization with an AI for everyone is offered, and picking it
   * finishes onboarding there and opens the app in it.
   */
  for (const engine of engines)
    test(`a new person picks another organization's AI on the step and the app opens there, in ${engine}`, async () => {
      // Default and Acme have no AI, and neither does the person; Globex has one for everyone.
      const server = new FakeServer("none");
      server.acme = personalFor("none");
      server.globex = personalFor("organization");
      const page = await open("/", server, engine, "light", WIDE);
      try {
        const others = await toTheStep(page, "Globex");
        // Acme has no AI either, so it is no way out.
        expect(
          await others.locator("[data-slot=item-title]").allTextContents(),
        ).toEqual(["Globex"]);
        await others.getByRole("button", { name: /Globex/ }).click();
        // Nothing left to do: onboarding is finished there, and the app opens in Globex.
        const home = page.locator("[data-app-home]");
        await home.waitFor();
        expect(await home.getAttribute("data-organization")).toBe("globex");
        expect(new URL(page.url()).pathname).toBe("/");
        expect(server.active).toBe("globex");
        expect(server.completes).toBe(1);
        expect(
          await page
            .getByRole("heading", { name: "What should we call you?" })
            .count(),
        ).toBe(0);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`an organization whose AI is gone by the time it is picked holds them at the step there, in ${engine}`, async () => {
      const server = new FakeServer("none");
      server.globex = personalFor("organization");
      const page = await open("/", server, engine, "light", WIDE);
      try {
        const others = await toTheStep(page, "Globex");
        // Its AI is removed after the list was drawn and before the pick.
        server.globex = personalFor("none");
        const asked = page.waitForResponse((response) =>
          response
            .url()
            .endsWith("/api/v2/organizations/globex/people/me/ai-connection"),
        );
        await others.getByRole("button", { name: /Globex/ }).click();
        await asked;
        await page.waitForFunction(() => document.querySelector("h1") !== null);
        // Held at Connect your AI in Globex: not the name step, and not finished.
        await heading(page, "Connect your AI");
        expect(
          await page
            .getByRole("heading", { name: "What should we call you?" })
            .count(),
        ).toBe(0);
        expect(server.active).toBe("globex");
        expect(new URL(page.url()).searchParams.get("step")).toBe("ai");
        expect(server.completes).toBe(0);
        expect(server.onboarding.step).toBe(4);
        expect(await primary(page).isDisabled()).toBe(true);
      } finally {
        await page.close();
      }
    }, 60_000);

  for (const engine of engines)
    for (const theme of THEMES)
      test(`at a phone's width, scrolled to the end, Sign out stops just above the buttons' fade as every step's last line does, in ${engine}, ${theme}`, async () => {
        const server = new FakeServer("none", true);
        server.acme = personalFor("organization");
        const page = await open("/", server, engine, theme, PHONE);
        try {
          await heading(page, "Connect your AI");
          await page.getByText("Acme").first().waitFor();
          await style(page);
          await page.evaluate(() =>
            window.scrollTo(0, document.documentElement.scrollHeight),
          );
          await page.waitForTimeout(100);
          const room = await page.evaluate(() => {
            const footer = document.querySelector("footer");
            const signOut = [...document.querySelectorAll("button")].find(
              (button) =>
                button.textContent?.trim() === "Sign out" &&
                button.getBoundingClientRect().height > 0,
            );
            if (!footer || !signOut) return null;
            // The fade is drawn 32px above the footer (`before:-top-8 before:h-8`).
            return (
              footer.getBoundingClientRect().top -
              32 -
              signOut.getBoundingClientRect().bottom
            );
          });
          expect(room).not.toBeNull();
          // Clear of the fade, and no further: the frame keeps the fade's height above the
          // buttons for every step, so a step adding room of its own doubles the gap. Within a
          // pixel, for the sub-pixel sizes text is drawn at (styles.css scales it by 15/16).
          expect(room ?? -2).toBeGreaterThanOrEqual(-1);
          expect(room ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(8);
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot({
              path: join(
                shots,
                `connect-ai-step-bottom-${engine}-${theme}-${PHONE.width}.png`,
              ),
            });
          }
        } finally {
          await page.close();
        }
      }, 60_000);

  for (const engine of engines)
    test(`on Cloud the organization's AI is said to be the organization's, in ${engine}`, async () => {
      const server = new FakeServer("organization", true);
      server.personal = GetPersonalAiConnectionResponse.parse(
        example("PersonalAiConnectionExample"),
      ) as PersonalAiConnection;
      const page = await open(
        "/settings/providers",
        server,
        engine,
        "light",
        WIDE,
      );
      try {
        // Its key is the organization's, not the admin's own.
        await page
          .getByRole("button", {
            name: /OpenAI.*Uses your organization's OpenAI API key\./,
          })
          .waitFor();
      } finally {
        await page.close();
      }

      // With none set yet, the dialog sets one up rather than changing it.
      const unset = new FakeServer("organization", true);
      unset.personal = GetPersonalAiConnectionResponse.parse({
        ...example("PersonalAiConnectionExample"),
        organization: { ready: false, provider: null },
      }) as PersonalAiConnection;
      const second = await open(
        "/settings/providers",
        unset,
        engine,
        "light",
        WIDE,
      );
      try {
        await second
          .getByRole("button", {
            name: /Not chosen yet.*Choose an AI for everyone in your organization\./,
          })
          .click();
        const dialog = second.getByRole("dialog");
        await dialog
          .getByText("Set up your organization's AI", { exact: true })
          .waitFor();
        expect(await dialog.getByText("Change AI connection").count()).toBe(0);
      } finally {
        await second.close();
      }
    }, 60_000);

  for (const engine of engines)
    test(`the other way, a ChatGPT plan signs in in the browser with the address it lands on, connects, and Settings names it, in ${engine}`, async () => {
      const server = new FakeServer("none", true);
      const page = await open(
        "/onboarding?step=ai",
        server,
        engine,
        "light",
        WIDE,
      );
      try {
        await heading(page, "Connect your AI");
        const chooser = page.locator("[data-ai-chooser]");
        await chooser.getByRole("button", { name: /^OpenAI/ }).click();
        // The code comes first; copying the address is the other way, below it.
        expect(
          await chooser.getByText("This site can't be reached").count(),
        ).toBe(0);
        await chooser
          .getByRole("button", { name: "Copy an address instead" })
          .click();
        // Before OpenAI opens: what will happen, in order, and the page they will land on.
        for (const step of [
          "Sign in to ChatGPT and approve the request.",
          "Your browser then shows “This site can't be reached”. That's expected.",
          "Copy the address at the top of that page and paste it here.",
        ])
          await chooser
            .getByRole("listitem")
            .filter({ hasText: step })
            .waitFor();
        await chooser
          .getByRole("img", {
            name: "A browser tab that says “This site can't be reached”, with its address at the top marked to copy",
          })
          .waitFor();
        const signIn = chooser.getByRole("button", {
          name: "Sign in with ChatGPT",
          exact: true,
        });
        await signIn.click();
        // ChatGPT's page, opened and linked, and the field for the address it sends the browser to.
        const address = chooser.getByLabel("Address from your browser");
        await address.waitFor();
        await chooser
          .getByText(
            "Approve the request in OpenAI's tab. When it says “This site can't be reached”, copy its address and paste it below.",
          )
          .waitFor();
        expect(await address.getAttribute("placeholder")).toBe(
          "http://localhost:1455/auth/callback?code=…",
        );
        // An address to paste here, never Claude's code.
        expect(await chooser.getByLabel("Code from your browser").count()).toBe(
          0,
        );
        const chatgpt = String(example("AiSignInChatGptBrowserExample").url);
        expect(
          await chooser
            .getByRole("link", { name: "Open the sign-in page" })
            .getAttribute("href"),
        ).toBe(chatgpt);
        await openedIn(page, server, chatgpt);
        expect(server.opened).toContain(chatgpt);
        // No code to enter at ChatGPT, and no way to the code sign-in while this one waits.
        expect(await chooser.getByText("Verification code").count()).toBe(0);
        expect(
          await chooser
            .getByRole("button", { name: "Sign in with a code instead" })
            .count(),
        ).toBe(0);
        const alert = chooser.getByRole("alert");
        const finish = chooser.getByRole("button", {
          name: "Finish",
          exact: true,
        });

        // The wrong tab's address (OpenAI's own sign-in page): said here, and nothing is sent.
        await address.fill(chatgpt);
        await finish.click();
        await alert.waitFor();
        expect(await alert.textContent()).toBe(
          "That's the address of OpenAI's sign-in page. Finish signing in there, then copy the address of the page that won't load.",
        );
        expect(server.finishes).toEqual([]);
        expect(await address.getAttribute("aria-invalid")).toBe("true");

        // The clipboard, as a person's copy leaves it. Chromium's, as CI runs it; elsewhere typed.
        const clipboard = engine === "chromium";
        if (clipboard)
          await page
            .context()
            .grantPermissions(["clipboard-read", "clipboard-write"], {
              origin: ORIGIN,
            });
        const copy = (text: string) =>
          page.evaluate(
            (copied) => navigator.clipboard.writeText(copied),
            text,
          );

        // An address from another sign-in, pasted with the keyboard: sent at once, the server
        // refuses it, and the box stays open for the right one.
        const stale =
          "http://localhost:1455/auth/callback?code=ac_older&state=older";
        await address.fill("");
        if (clipboard) {
          await copy(stale);
          await address.focus();
          await page.keyboard.press("ControlOrMeta+V");
        } else {
          await address.fill(stale);
          await finish.click();
        }
        await chooser.getByText(CHATGPT_OTHER_SIGN_IN).waitFor();
        expect(await address.isVisible()).toBe(true);
        expect(await address.inputValue()).toBe(stale);
        expect(
          await chooser.getByRole("button", { name: "Connect" }).isDisabled(),
        ).toBe(true);

        // Back from OpenAI's tab with the box empty: the cursor waits in it.
        await address.fill("");
        await page.evaluate(() => {
          (document.activeElement as HTMLElement | null)?.blur();
          window.dispatchEvent(new Event("focus"));
        });
        expect(
          await page.evaluate(() => document.activeElement?.id ?? null),
        ).toBe("ai-connection-code");

        // ChatGPT sent the browser back with an error: the sign-in is over, and starts again.
        await address.fill(
          "http://localhost:1455/auth/callback?error=access_denied&state=example",
        );
        await finish.click();
        await chooser.getByText(CHATGPT_NOT_APPROVED).waitFor();
        await signIn.waitFor();
        expect(await address.count()).toBe(0);
        await signIn.click();
        await address.waitFor();

        // The right address, with the spaces a copy brings, by Paste: it finishes at once.
        if (clipboard) {
          await copy(`  ${CHATGPT_ADDRESS}\n`);
          await chooser.getByRole("button", { name: "Paste" }).click();
        } else {
          await address.fill(`  ${CHATGPT_ADDRESS}\n`);
          await finish.click();
        }
        await chooser.getByText("Signed in to OpenAI.").waitFor();
        // The browser sign-in, the default: no method asked for.
        expect(server.signIns).toEqual([
          { provider: "openai" },
          { provider: "openai" },
        ]);
        expect(server.finishes).toEqual([
          { code: stale },
          {
            code: "http://localhost:1455/auth/callback?error=access_denied&state=example",
          },
          { code: CHATGPT_ADDRESS },
        ]);
        // Finished by the address alone: never read in a loop.
        expect(server.signInReads).toBe(0);
        await chooser.getByRole("button", { name: "Connect" }).click();
        const connected = chooser.getByRole("status");
        await connected.waitFor();
        expect(server.replaces).toEqual([
          { provider: "openai", login: "plan" },
        ]);
        expect(await connected.textContent()).toContain(
          "Signed in with your ChatGPT plan.",
        );

        await primary(page).click();
        await page.locator("[data-app-home]").waitFor();
        await page.goto(`${ORIGIN}/settings/providers`);
        await page
          .getByRole("button", {
            name: /OpenAI.*Signed in with your ChatGPT plan\./,
          })
          .click();
        const dialog = page.getByRole("dialog");
        await dialog
          .getByText(
            "Bots use OpenAI when they work for you. It's yours alone, and OpenBot keeps you signed in.",
          )
          .waitFor();
        await dialog.getByText("ChatGPT plan", { exact: true }).waitFor();
      } finally {
        await page.close();
      }
    }, 90_000);

  for (const engine of engines)
    test(`a ChatGPT plan signs in with a code first, the setting it needs said and linked, read until approved, in ${engine}`, async () => {
      const server = new FakeServer("none", true);
      // The first code is never approved (the setting was off at ChatGPT); a new one is.
      server.outcomes = ["never", "approved"];
      const page = await open(
        "/onboarding?step=ai",
        server,
        engine,
        "light",
        WIDE,
      );
      try {
        await heading(page, "Connect your AI");
        const chooser = page.locator("[data-ai-chooser]");
        await chooser.getByRole("button", { name: /^OpenAI/ }).click();
        // First: the setting ChatGPT needs, and the link straight to it. No page that won't load.
        for (const step of [
          "Turn on device code sign-in in ChatGPT. Under Security and login, switch on “Enable device code sign-in”.",
          "Sign in with ChatGPT below to get a code.",
          "Enter the code on OpenAI's page and approve. It finishes on its own.",
        ])
          await chooser
            .getByRole("listitem")
            .filter({ hasText: step })
            .waitFor();
        await chooser
          .getByText(
            "On a Team or Enterprise workspace, your ChatGPT workspace admin turns it on.",
          )
          .waitFor();
        const settings = chooser.getByRole("link", {
          name: "Open ChatGPT's security settings",
        });
        expect(await settings.getAttribute("href")).toBe(
          CHATGPT_SECURITY_SETTINGS,
        );
        expect(await settings.getAttribute("target")).toBe("_blank");
        expect(
          await chooser.getByText("This site can't be reached").count(),
        ).toBe(0);
        // The other way, below it.
        await chooser
          .getByRole("button", { name: "Copy an address instead" })
          .waitFor();
        await chooser
          .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
          .click();
        // The code to enter on ChatGPT's page, and the page itself: opened, and linked.
        await chooser.getByText("VU3W-87566").waitFor();
        await chooser
          .getByText(
            "OpenAI opens in your browser. Enter the code shown here, then approve. It finishes on its own.",
          )
          .waitFor();
        const device = String(example("AiSignInChatGptExample").url);
        expect(
          await chooser
            .getByRole("link", { name: "Open the sign-in page" })
            .getAttribute("href"),
        ).toBe(device);
        expect(
          await chooser.getByLabel("Address from your browser").count(),
        ).toBe(0);
        // Waiting: if ChatGPT's page says the setting is off, the link to it, and a new code.
        expect(
          await chooser
            .getByRole("link", { name: "ChatGPT's security settings" })
            .getAttribute("href"),
        ).toBe(CHATGPT_SECURITY_SETTINGS);
        await chooser
          .getByRole("button", { name: "Copy an address instead" })
          .waitFor({ state: "detached" });
        await chooser.getByRole("button", { name: "Get a new code" }).click();
        // Read every interval until ChatGPT says it is approved: pending once, then approved.
        await chooser.getByText("Signed in to OpenAI.").waitFor();
        expect(server.signIns).toEqual([
          { provider: "openai", method: "device" },
          { provider: "openai", method: "device" },
        ]);
        expect(server.signIn?.reads).toBe(2);
        expect(server.finishes).toEqual([]);
        await openedIn(page, server, device);
        expect(server.opened).toContain(device);
        await chooser.getByRole("button", { name: "Connect" }).click();
        const connected = chooser.getByRole("status");
        await connected.waitFor();
        expect(server.replaces).toEqual([
          { provider: "openai", login: "plan" },
        ]);
        expect(await connected.textContent()).toContain(
          "Signed in with your ChatGPT plan.",
        );
      } finally {
        await page.close();
      }
    }, 90_000);

  for (const engine of engines)
    test(`the code to enter on the provider's page copies with one press, for ChatGPT and xAI, in ${engine}`, async () => {
      const server = new FakeServer("none", true);
      // Both wait to be approved, so the code stays on screen.
      server.outcomes = ["never", "never"];
      const page = await open(
        "/onboarding?step=ai",
        server,
        engine,
        "light",
        WIDE,
      );
      // Chromium reads the clipboard back with leave to. WebKit writes on a press without asking,
      // but refuses a read that no press started, so there the test notes what the page handed
      // the real clipboard and reads that.
      if (engine === "chromium")
        await page
          .context()
          .grantPermissions(["clipboard-read", "clipboard-write"], {
            origin: ORIGIN,
          });
      const clipboard = () =>
        engine === "chromium"
          ? page.evaluate(() => navigator.clipboard.readText())
          : page.evaluate(
              () =>
                (window as unknown as { __written?: string }).__written ?? "",
            );
      try {
        await heading(page, "Connect your AI");
        if (engine !== "chromium")
          await page.evaluate(() => {
            const board = navigator.clipboard;
            const write = board.writeText.bind(board);
            board.writeText = async (text: string) => {
              await write(text);
              (window as unknown as { __written?: string }).__written = text;
            };
          });
        const chooser = page.locator("[data-ai-chooser]");
        const copy = chooser.getByRole("button", { name: "Copy the code" });

        // ChatGPT's code: copied as shown, and the button says so.
        await chooser.getByRole("button", { name: /^OpenAI/ }).click();
        await chooser
          .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
          .click();
        await chooser.getByText("VU3W-87566").waitFor();
        expect(await copy.textContent()).toBe("Copy");
        await copy.click();
        await chooser
          .getByRole("button", { name: "Copy the code" })
          .filter({
            hasText: "Copied",
          })
          .waitFor();
        expect(await clipboard()).toBe("VU3W-87566");
        expect(await chooser.getByRole("alert").count()).toBe(0);

        // xAI's, the same way.
        await chooser.getByRole("button", { name: "Cancel sign-in" }).click();
        await copy.waitFor({ state: "detached" });
        await chooser.getByRole("button", { name: "Back" }).click();
        await chooser.getByRole("button", { name: /^xAI/ }).click();
        await chooser
          .getByRole("button", { name: "Sign in with xAI", exact: true })
          .click();
        await chooser.getByText("MQ7T-WD4X").waitFor();
        expect(await copy.textContent()).toBe("Copy");
        await copy.click();
        await chooser
          .getByRole("button", { name: "Copy the code" })
          .filter({
            hasText: "Copied",
          })
          .waitFor();
        expect(await clipboard()).toBe("MQ7T-WD4X");
      } finally {
        await page.close();
      }
    }, 90_000);

  for (const engine of engines)
    test(`ChatGPT giving no code says the setting is off and links to it, and the address is still a way in, in ${engine}`, async () => {
      const server = new FakeServer("none", true);
      server.deviceOff = true;
      const page = await open(
        "/onboarding?step=ai",
        server,
        engine,
        "light",
        WIDE,
      );
      try {
        await heading(page, "Connect your AI");
        const chooser = page.locator("[data-ai-chooser]");
        await chooser.getByRole("button", { name: /^OpenAI/ }).click();
        const signIn = chooser.getByRole("button", {
          name: "Sign in with ChatGPT",
          exact: true,
        });
        await signIn.click();
        // What is off, said plainly, never the server's own sentence, with the link to the setting.
        const alert = chooser.getByRole("alert");
        await alert.waitFor();
        expect(await alert.textContent()).toBe(CHATGPT_DEVICE_OFF);
        const links = chooser.getByRole("link", {
          name: "Open ChatGPT's security settings",
        });
        // In the first step, and again under what went wrong.
        expect(await links.count()).toBe(2);
        for (const href of await links.evaluateAll((all) =>
          all.map((link) => link.getAttribute("href")),
        ))
          expect(href).toBe(CHATGPT_SECURITY_SETTINGS);
        expect(await chooser.getByText("VU3W-87566").count()).toBe(0);
        expect(
          await chooser.getByRole("button", { name: "Connect" }).isDisabled(),
        ).toBe(true);
        expect(server.signIns).toEqual([
          { provider: "openai", method: "device" },
        ]);

        // The other way is still there: the address, with its steps first, and it finishes.
        await chooser
          .getByRole("button", { name: "Copy an address instead" })
          .click();
        expect(await alert.count()).toBe(0);
        await chooser
          .getByRole("listitem")
          .filter({
            hasText:
              "Your browser then shows “This site can't be reached”. That's expected.",
          })
          .waitFor();
        await signIn.click();
        const address = chooser.getByLabel("Address from your browser");
        await address.fill(CHATGPT_ADDRESS);
        await chooser
          .getByRole("button", { name: "Finish", exact: true })
          .click();
        await chooser.getByText("Signed in to OpenAI.").waitFor();
        expect(server.signIns).toEqual([
          { provider: "openai", method: "device" },
          { provider: "openai" },
        ]);
        expect(server.finishes).toEqual([{ code: CHATGPT_ADDRESS }]);

        // And back: the code is one press away, the address steps gone.
        await chooser.getByRole("button", { name: "Back" }).click();
        await chooser.getByRole("button", { name: /^OpenAI/ }).click();
        await chooser
          .getByRole("button", { name: "Copy an address instead" })
          .click();
        await chooser
          .getByRole("button", { name: "Sign in with a code instead" })
          .click();
        await chooser
          .getByRole("link", { name: "Open ChatGPT's security settings" })
          .waitFor();
        expect(
          await chooser.getByText("This site can't be reached").count(),
        ).toBe(0);
      } finally {
        await page.close();
      }
    }, 90_000);

  for (const engine of engines)
    test(`a Claude plan signs in with the code Claude's page shows, in Settings, in ${engine}`, async () => {
      const server = new FakeServer("organization", true);
      const page = await open(
        "/settings/providers",
        server,
        engine,
        "light",
        WIDE,
      );
      try {
        await page
          .getByRole("button", { name: /Your organization's AI/ })
          .click();
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("button", { name: /^Anthropic/ }).waitFor();
        // Styled, so the dialog sits over its backdrop as it does in the app.
        await style(page);
        await dialog.getByRole("button", { name: /^Anthropic/ }).click();
        expect(await dialog.getByRole("tab").allTextContents()).toEqual([
          "Sign in with my plan",
          "Use an API key",
        ]);
        const signIn = dialog.getByRole("button", {
          name: "Sign in with Anthropic",
          exact: true,
        });
        await signIn.click();
        const code = dialog.getByLabel("Code from your browser");
        await code.waitFor();
        expect(
          await dialog
            .getByRole("link", { name: "Open the sign-in page" })
            .getAttribute("href"),
        ).toBe(String(example("AiSignInClaudeExample").url));

        // A code Claude didn't give: the server's sentence, and the way to sign in again.
        await code.fill("not-the-code");
        await dialog
          .getByRole("button", { name: "Finish", exact: true })
          .click();
        const alert = dialog.getByRole("alert");
        await alert.waitFor();
        expect(await alert.textContent()).toBe(
          "Claude didn't approve the sign-in. Sign in again.",
        );
        await signIn.click();
        await code.fill(`  ${CLAUDE_CODE}  `);
        await dialog
          .getByRole("button", { name: "Finish", exact: true })
          .click();
        await dialog.getByText("Signed in to Anthropic.").waitFor();
        expect(server.signIns).toEqual([
          { provider: "anthropic" },
          { provider: "anthropic" },
        ]);
        expect(server.finishes).toEqual([
          { code: "not-the-code" },
          { code: CLAUDE_CODE },
        ]);
        // Finished by the code alone: never read in a loop.
        expect(server.signInReads).toBe(0);

        await dialog.getByRole("button", { name: "Connect" }).click();
        await dialog.getByText("Connected to Anthropic").waitFor();
        expect(server.replaces).toEqual([
          { provider: "anthropic", login: "plan" },
        ]);
        await dialog.getByRole("button", { name: "Done" }).click();
        await page
          .getByRole("button", {
            name: /Anthropic.*Signed in with your Claude plan\./,
          })
          .waitFor();
      } finally {
        await page.close();
      }
    }, 90_000);

  for (const engine of engines)
    test(`xAI signs in with the code on its page, and Google on its own page, in ${engine}`, async () => {
      const server = new FakeServer("none", true);
      const page = await open(
        "/onboarding?step=ai",
        server,
        engine,
        "light",
        WIDE,
      );
      try {
        await heading(page, "Connect your AI");
        const chooser = page.locator("[data-ai-chooser]");
        await chooser.getByRole("button", { name: /^xAI/ }).click();
        expect(await chooser.getByRole("tab").allTextContents()).toEqual([
          "Sign in",
          "Use an API key",
        ]);
        await chooser
          .getByRole("button", { name: "Sign in with xAI", exact: true })
          .click();
        await chooser.getByText("MQ7T-WD4X").waitFor();
        await chooser.getByText("Signed in to xAI.").waitFor();
        expect(await chooser.getByLabel("Model name").inputValue()).toBe(
          "grok-4.7",
        );
        await chooser.getByRole("button", { name: "Connect" }).click();
        const connected = chooser.getByRole("status");
        await connected.waitFor();
        expect(server.replaces).toEqual([
          { provider: "xai", login: "oauth", model: "grok-4.7" },
        ]);
        expect(await connected.textContent()).toContain(
          "Signed in with your xAI account. Model: grok-4.7",
        );
      } finally {
        await page.close();
      }

      const google = new FakeServer("none", true);
      const second = await open(
        "/onboarding?step=ai",
        google,
        engine,
        "light",
        WIDE,
      );
      try {
        await heading(second, "Connect your AI");
        const chooser = second.locator("[data-ai-chooser]");
        await chooser.getByRole("button", { name: /^Google Gemini/ }).click();
        expect(await chooser.getByRole("tab").allTextContents()).toEqual([
          "Sign in",
          "Use an API key",
        ]);
        // Google's own words beside its G: "Sign in with Google".
        await chooser
          .getByRole("button", { name: "Sign in with Google", exact: true })
          .click();
        // Google's page sends the person back to OpenBot: no code to check or paste, only the wait.
        await chooser
          .getByText("Waiting for you to approve it in your browser…")
          .waitFor();
        expect(await chooser.getByText("Verification code").count()).toBe(0);
        expect(await chooser.getByLabel("Code from your browser").count()).toBe(
          0,
        );
        await chooser.getByText("Signed in to Google Gemini.").waitFor();
        expect(google.signIns).toEqual([{ provider: "google" }]);
        expect(google.finishes).toEqual([]);
        expect(google.opened[0]).toStartWith(
          "https://accounts.google.com/o/oauth2/v2/auth",
        );
        await chooser.getByRole("button", { name: "Connect" }).click();
        const connected = chooser.getByRole("status");
        await connected.waitFor();
        expect(google.replaces).toEqual([
          { provider: "google", login: "oauth", model: "gemini-3.8-flash" },
        ]);
        expect(await connected.textContent()).toContain(
          "Signed in with your Google account. Model: gemini-3.8-flash",
        );
      } finally {
        await second.close();
      }
    }, 90_000);

  for (const engine of engines)
    test(`a failed or expired sign-in says why and signs in again, and leaving the row stops reading it, in ${engine}`, async () => {
      const server = new FakeServer("none", true);
      server.outcomes = ["failed", "expired", "approved", "never"];
      const page = await open(
        "/onboarding?step=ai",
        server,
        engine,
        "light",
        WIDE,
      );
      try {
        await heading(page, "Connect your AI");
        const chooser = page.locator("[data-ai-chooser]");
        await chooser.getByRole("button", { name: /^xAI/ }).click();
        const signIn = chooser.getByRole("button", {
          name: "Sign in with xAI",
          exact: true,
        });
        const alert = chooser.getByRole("alert");
        await signIn.click();
        await alert.waitFor();
        expect(await alert.textContent()).toBe(
          "xAI didn't approve the sign-in. Sign in again.",
        );
        // Nothing to connect yet.
        expect(
          await chooser.getByRole("button", { name: "Connect" }).isDisabled(),
        ).toBe(true);
        await signIn.click();
        await chooser
          .getByText("The xAI sign-in expired. Sign in again.")
          .waitFor();
        await signIn.click();
        await chooser.getByText("Signed in to xAI.").waitFor();
        expect(await alert.count()).toBe(0);
        expect(server.signIns).toHaveLength(3);

        // A sign-in still waiting stops being read once the person leaves the row.
        await chooser.getByRole("button", { name: "Back" }).click();
        await chooser.getByRole("button", { name: /^xAI/ }).click();
        await signIn.click();
        await page.waitForFunction(
          () => document.body.textContent?.includes("MQ7T-WD4X") ?? false,
        );
        await page.waitForTimeout(1_500);
        await chooser.getByRole("button", { name: "Back" }).click();
        const reads = server.signIn?.reads ?? 0;
        expect(reads).toBeGreaterThan(0);
        await page.waitForTimeout(2_500);
        expect(server.signIn?.reads).toBe(reads);
      } finally {
        await page.close();
      }
    }, 90_000);

  for (const engine of engines)
    test(`Use an API key still connects each provider, in ${engine}`, async () => {
      const keys: [RegExp, string, Record<string, unknown>][] = [
        [
          /^OpenAI/,
          "OpenAI API key",
          { provider: "openai", login: "api-key", apiKey: "sk-typed-key" },
        ],
        [
          /^Anthropic/,
          "Anthropic API key",
          { provider: "anthropic", login: "api-key", apiKey: "sk-typed-key" },
        ],
        [
          /^Google Gemini/,
          "Google Gemini API key",
          {
            provider: "google",
            login: "endpoint",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
            model: "gemini-3.8-flash",
            apiKey: "sk-typed-key",
          },
        ],
        [
          /^xAI/,
          "xAI API key",
          {
            provider: "xai",
            login: "endpoint",
            baseUrl: "https://api.x.ai/v1",
            model: "grok-4.7",
            apiKey: "sk-typed-key",
          },
        ],
        [
          /^Unbiased AI/,
          "Unbiased AI API key",
          {
            provider: "unbiased",
            login: "endpoint",
            baseUrl: "https://api.unbiased.ai/v1",
            model: "pareto",
            apiKey: "sk-typed-key",
          },
        ],
      ];
      for (const [row, label, body] of keys) {
        const server = new FakeServer("none", true);
        const page = await open(
          "/onboarding?step=ai",
          server,
          engine,
          "light",
          WIDE,
        );
        try {
          await heading(page, "Connect your AI");
          const chooser = page.locator("[data-ai-chooser]");
          await chooser.getByRole("button", { name: row }).click();
          await chooser.getByRole("tab", { name: "Use an API key" }).click();
          await chooser.getByLabel(label).fill("sk-typed-key");
          await chooser.getByRole("button", { name: "Connect" }).click();
          await chooser.getByRole("status").waitFor();
          expect(server.replaces).toEqual([body]);
          expect(server.signIns).toEqual([]);
        } finally {
          await page.close();
        }
      }
    }, 120_000);

  // Every screen this adds, light and dark, wide and at a phone's width, beside the screens from
  // before they should match: onboarding's Welcome and Settings' AI connection dialog.
  test.skipIf(!shots)(
    "screenshots of the step and Settings, beside Welcome and the AI connection dialog",
    async () => {
      for (const engine of engines)
        for (const theme of THEMES)
          for (const window of [WIDE, PHONE]) {
            const fresh = new FakeServer("none");
            const page = await open("/", fresh, engine, theme, window);
            try {
              await heading(page, "Welcome to OpenBot");
              await shoot(page, "compare-welcome", engine, theme, window);
              await page.waitForFunction(
                () =>
                  !document
                    .querySelector("[data-onboarding-primary]")
                    ?.hasAttribute("disabled"),
              );
              await primary(page).click();
              await heading(page, "Connect your AI");
              expect(await measured(page)).toEqual(FINE);
              await shoot(page, "step", engine, theme, window);
              const chooser = page.locator("[data-ai-chooser]");
              await chooser
                .getByRole("button", { name: /^Unbiased AI/ })
                .click();
              expect(await measured(page)).toEqual(FINE);
              await shoot(page, "step-unbiased", engine, theme, window);
              await chooser
                .getByRole("tab", { name: "Use an API key" })
                .click();
              await chooser.getByLabel("Unbiased AI API key").fill("ub-key");
              await chooser.getByRole("button", { name: "Connect" }).click();
              await chooser.getByRole("status").waitFor();
              expect(await measured(page)).toEqual(FINE);
              await shoot(page, "step-connected", engine, theme, window);
            } finally {
              await page.close();
            }

            const own = new FakeServer("organization", true);
            own.personal = GetPersonalAiConnectionResponse.parse(
              example("PersonalAiConnectionExample"),
            ) as PersonalAiConnection;
            const settings = await open(
              "/settings/providers",
              own,
              engine,
              theme,
              window,
            );
            try {
              await settings
                .getByRole("heading", { name: "Your AI" })
                .waitFor();
              await settings
                .getByRole("heading", { name: "Organization's AI" })
                .waitFor();
              expect(await measured(settings)).toEqual(FINE);
              await shoot(settings, "settings", engine, theme, window);
              await settings
                .getByRole("button", { name: /Anthropic.*Uses your Anthropic/ })
                .click();
              await settings.getByRole("dialog").waitFor();
              await shoot(settings, "settings-dialog", engine, theme, window);
              await settings
                .getByRole("dialog")
                .getByRole("button", { name: "Change", exact: true })
                .click();
              await settings
                .getByRole("dialog")
                .getByRole("button", { name: /^Unbiased AI/ })
                .waitFor();
              await shoot(settings, "settings-chooser", engine, theme, window);
              await settings.keyboard.press("Escape");
              await settings.getByRole("dialog").waitFor({ state: "detached" });
              // The organization's AI connection dialog from before, to compare.
              await settings
                .getByRole("button", { name: /Not chosen yet|OpenAI/ })
                .first()
                .click();
              await settings.getByRole("dialog").waitFor();
              await shoot(
                settings,
                "compare-org-dialog",
                engine,
                theme,
                window,
              );
            } finally {
              await settings.close();
            }

            // The step for somebody in two organizations: the other one to work in instead.
            const two = new FakeServer("none", true);
            two.acme = personalFor("organization");
            const both = await open("/", two, engine, theme, window);
            try {
              await heading(both, "Connect your AI");
              await both
                .getByRole("heading", {
                  name: "Or work in another organization",
                })
                .first()
                .waitFor();
              expect(await measured(both)).toEqual(FINE);
              await shoot(
                both,
                "step-other-organizations",
                engine,
                theme,
                window,
              );
            } finally {
              await both.close();
            }

            // The organization's AI with none set yet: the dialog sets one up.
            const unset = new FakeServer("organization", true);
            unset.personal = GetPersonalAiConnectionResponse.parse({
              ...example("PersonalAiConnectionExample"),
              organization: { ready: false, provider: null },
            }) as PersonalAiConnection;
            const setup = await open(
              "/settings/providers",
              unset,
              engine,
              theme,
              window,
            );
            try {
              await setup
                .getByRole("button", { name: /Not chosen yet/ })
                .click();
              await setup.getByRole("dialog").waitFor();
              await shoot(setup, "org-setup-dialog", engine, theme, window);
            } finally {
              await setup.close();
            }
          }
    },
    600_000,
  );

  // Each sign-in state, on the step and in Settings, light and dark, wide and at a phone's width.
  test.skipIf(!shots)(
    "screenshots of every sign-in state, on the step and in Settings",
    async () => {
      for (const engine of engines)
        for (const theme of THEMES)
          for (const window of [WIDE, PHONE]) {
            const server = new FakeServer("none", true);
            // ChatGPT waits with its code, then gives none, then waits for its address; Claude
            // finishes by its code; Google stays waiting; xAI fails once.
            server.outcomes = ["never", "never", "approved", "never", "failed"];
            const page = await open(
              "/onboarding?step=ai",
              server,
              engine,
              theme,
              window,
            );
            const look = async (screen: string) => {
              expect(await measured(page)).toEqual(FINE);
              await shoot(page, screen, engine, theme, window);
            };
            try {
              await heading(page, "Connect your AI");
              const chooser = page.locator("[data-ai-chooser]");
              const row = (name: RegExp) =>
                chooser.getByRole("button", { name }).click();
              const back = () =>
                chooser.getByRole("button", { name: "Back" }).click();

              await row(/^OpenAI/);
              await look("sign-in-chatgpt");
              const chatGpt = chooser.getByRole("button", {
                name: "Sign in with ChatGPT",
                exact: true,
              });
              await chatGpt.click();
              await chooser.getByText("VU3W-87566").waitFor();
              await look("sign-in-chatgpt-code-waiting");
              await chooser
                .getByRole("button", { name: "Cancel sign-in" })
                .click();
              server.deviceOff = true;
              await chatGpt.click();
              await chooser.getByText(CHATGPT_DEVICE_OFF).waitFor();
              await look("sign-in-chatgpt-code-off");
              server.deviceOff = false;
              await chooser
                .getByRole("button", { name: "Copy an address instead" })
                .click();
              await look("sign-in-chatgpt-address-steps");
              await chatGpt.click();
              await chooser.getByLabel("Address from your browser").waitFor();
              await look("sign-in-chatgpt-paste");
              await chooser
                .getByLabel("Address from your browser")
                .fill(
                  "http://localhost:1455/auth/callback?code=ac_older&state=older",
                );
              await chooser
                .getByRole("button", { name: "Finish", exact: true })
                .click();
              await chooser.getByText(CHATGPT_OTHER_SIGN_IN).waitFor();
              await look("sign-in-chatgpt-wrong-paste");
              await back();

              await row(/^Anthropic/);
              await chooser
                .getByRole("button", { name: "Sign in with Anthropic" })
                .click();
              await chooser.getByLabel("Code from your browser").waitFor();
              await look("sign-in-claude-code");
              await chooser
                .getByLabel("Code from your browser")
                .fill(CLAUDE_CODE);
              await chooser
                .getByRole("button", { name: "Finish", exact: true })
                .click();
              await chooser.getByText("Signed in to Anthropic.").waitFor();
              await look("sign-in-claude-signed-in");
              await back();

              await row(/^Google Gemini/);
              await look("sign-in-google");
              await chooser
                .getByRole("button", { name: "Sign in with Google" })
                .click();
              await chooser
                .getByText("Waiting for you to approve it in your browser…")
                .waitFor();
              await look("sign-in-google-waiting");
              await back();

              await row(/^xAI/);
              await chooser
                .getByRole("button", { name: "Sign in with xAI" })
                .click();
              await chooser.getByRole("alert").waitFor();
              await look("sign-in-xai-failed");
              await chooser
                .getByRole("button", { name: "Sign in with xAI" })
                .click();
              await chooser.getByText("Signed in to xAI.").waitFor();
              await look("sign-in-xai-signed-in");
              await chooser.getByRole("button", { name: "Connect" }).click();
              await chooser.getByRole("status").waitFor();
              await look("sign-in-xai-connected");
            } finally {
              await page.close();
            }

            // Settings, on a Claude plan the server signed in to.
            const own = new FakeServer("organization", true);
            const mine = example("PersonalAiConnectionExample") as {
              connection: Record<string, unknown>;
            };
            own.personal = GetPersonalAiConnectionResponse.parse({
              ...mine,
              connection: {
                ...mine.connection,
                provider: "anthropic",
                login: "plan",
                model: null,
                endpointHost: null,
              },
            }) as PersonalAiConnection;
            // ChatGPT's code and its address both stay waiting, to be seen.
            own.outcomes = ["never", "never"];
            const settings = await open(
              "/settings/providers",
              own,
              engine,
              theme,
              window,
            );
            try {
              await settings
                .getByRole("button", {
                  name: /Anthropic.*Signed in with your Claude plan\./,
                })
                .waitFor();
              expect(await measured(settings)).toEqual(FINE);
              await shoot(settings, "settings-plan", engine, theme, window);
              await settings
                .getByRole("button", {
                  name: /Anthropic.*Signed in with your Claude plan\./,
                })
                .click();
              await settings.getByRole("dialog").waitFor();
              await shoot(
                settings,
                "settings-plan-dialog",
                engine,
                theme,
                window,
              );
              await settings
                .getByRole("dialog")
                .getByRole("button", { name: "Change", exact: true })
                .click();
              await settings
                .getByRole("dialog")
                .getByRole("button", { name: /^OpenAI/ })
                .click();
              await shoot(
                settings,
                "settings-chatgpt-steps",
                engine,
                theme,
                window,
              );
              const dialogSignIn = settings
                .getByRole("dialog")
                .getByRole("button", {
                  name: "Sign in with ChatGPT",
                  exact: true,
                });
              await dialogSignIn.click();
              await settings
                .getByRole("dialog")
                .getByText("VU3W-87566")
                .waitFor();
              await shoot(
                settings,
                "settings-chatgpt-code-waiting",
                engine,
                theme,
                window,
              );
              await settings
                .getByRole("dialog")
                .getByRole("button", { name: "Cancel sign-in" })
                .click();
              await settings
                .getByRole("dialog")
                .getByRole("button", { name: "Copy an address instead" })
                .click();
              await shoot(
                settings,
                "settings-chatgpt-address-steps",
                engine,
                theme,
                window,
              );
              await dialogSignIn.click();
              await settings
                .getByRole("dialog")
                .getByLabel("Address from your browser")
                .waitFor();
              await shoot(
                settings,
                "settings-chatgpt-paste",
                engine,
                theme,
                window,
              );
            } finally {
              await settings.close();
            }
          }
    },
    600_000,
  );
});
