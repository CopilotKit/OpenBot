/**
 * The addresses of the server a client may write by hand, and the requests it may send by hand,
 * each with the rule it follows. api/client-boundary.test.ts fails on anything else.
 *
 * Every client reaches the server through the API, using the client generated from
 * api/openapi.yaml. What is left outside is outside for a reason that has a name:
 *
 * - sign-in-protocol: sign-in's own protocol, `/api/auth/*`, OAuth, and an app account's verifier.
 *   Better Auth and the OAuth flows own their addresses and their wire format.
 * - before-sign-in: a liveness check made before anybody signs in (`/health`, `/release`, and
 *   `/api/capabilities`, which released Desktop shells, 1.0.2 and 1.0.3, ask when they start a newer
 *   installation).
 * - machine-credential: a caller that is a machine with its own credential, not a person or an
 *   app: Desktop's host token, a Bot's harness calling back for a tool, the model proxy, the
 *   Learning model, a webhook.
 * - runtime: the CopilotKit runtime's protocol, `/api/copilotkit/*`, which carries runs.
 * - socket: a WebSocket, described in api/asyncapi.yaml rather than api/openapi.yaml.
 * - stored-format: an address kept inside stored data, such as a sent message's attachment, which
 *   the client resolves to the API's address before it reads it.
 * - installed-client: an address a released client calls and cannot be moved off: the connect code
 *   released Desktop shells, 1.0.2 and 1.0.3, ask for and hand to a Recorder.
 * - hand-built-v2: an address in the API's place, built by a client that has no generated client:
 *   Desktop's native side, which is Rust. A whole one must be an operation or a channel the API
 *   describes.
 * - server-routes: a path table in shared/ that the server registers today's routes from, which no
 *   client calls. It goes when those addresses are retired.
 * - third-party: another service's address, not OpenBot's server.
 * - transport: the code that sends every request (the generated client's own transport, a client's
 *   one request function, the app's server forwarding `/api`), naming no address of its own.
 * - temporary: a call made by hand today that is moving onto the API. Each one is in TEMPORARY and
 *   names what removes it; that change deletes its entry, and the test then fails if the call is
 *   still there.
 */

export const RULES = [
  "sign-in-protocol",
  "before-sign-in",
  "machine-credential",
  "runtime",
  "socket",
  "stored-format",
  "installed-client",
  "hand-built-v2",
  "server-routes",
  "third-party",
  "transport",
  "temporary",
] as const;
export type Rule = (typeof RULES)[number];

export type Allowed = {
  /** The file, from the repository's root. */
  file: string;
  /** The address (interpolations written `{}`) or the request (`fetch()`, `new WebSocket()`). */
  what: string | RegExp;
  rule: Rule;
  why: string;
};
export type Temporary = Allowed & {
  rule: "temporary";
  /** What removes it. */
  until: string;
};

/**
 * The addresses outside the API that stay, by where they start. An address allowed for good that
 * is not in the API's place must start with one of these. The server keeps serving exactly these.
 */
export const STAYS: { prefix: string; rule: Rule; why: string }[] = [
  {
    prefix: "/api/auth",
    rule: "sign-in-protocol",
    why: "Better Auth's sign-in, sessions, SSO and SCIM",
  },
  {
    prefix: "/api/plugins/arcade/verify",
    rule: "sign-in-protocol",
    why: "where an app account's sign-in comes back to be verified",
  },
  {
    prefix: "/api/install/enter",
    rule: "sign-in-protocol",
    why: "where a single-user OpenBot's own app enters with its install's token, which sets the cookie it carries",
  },
  {
    prefix: "/api/copilotkit",
    rule: "runtime",
    why: "the CopilotKit runtime, which carries runs",
  },
  {
    prefix: "/api/agent-tools",
    rule: "machine-credential",
    why: "a Bot's harness calling back for a tool",
  },
  {
    prefix: "/api/model-provider",
    rule: "machine-credential",
    why: "the model proxy a Bot's harness calls",
  },
  {
    prefix: "/api/learning-model",
    rule: "machine-credential",
    why: "the model Learning calls",
  },
  {
    prefix: "/api/desktop",
    rule: "machine-credential",
    why: "Desktop asking its own server, with its host token",
  },
  {
    prefix: "/api/host-access/desktop",
    rule: "machine-credential",
    why: "Desktop's host access, with its host token",
  },
  {
    prefix: "/api/events",
    rule: "machine-credential",
    why: "webhooks from GitHub and email, signed by their senders",
  },
  {
    prefix: "/api/capabilities",
    rule: "before-sign-in",
    why: "released Desktop shells, 1.0.2 and 1.0.3, ask it when they start a newer installation",
  },
  {
    prefix: "/api/recorder/connect-codes",
    rule: "installed-client",
    why: "released Desktop shells, 1.0.2 and 1.0.3, hand a Recorder its connect code here",
  },
  {
    prefix: "/api/attachments",
    rule: "stored-format",
    why: "the form a sent message keeps its attachment in",
  },
  { prefix: "/health", rule: "before-sign-in", why: "a liveness check" },
  {
    prefix: "/release",
    rule: "before-sign-in",
    why: "which release a server on this machine runs",
  },
  {
    prefix: "/.well-known",
    rule: "before-sign-in",
    why: "OAuth's discovery and other published metadata",
  },
];

/** What stays outside the generated client for good. */
export const ALLOWED: Allowed[] = [
  // The transports every request goes through.
  {
    file: "app/src/lib/client.ts",
    what: "fetch()",
    rule: "transport",
    why: "the app's one request function, which the generated client's mutator calls",
  },
  {
    file: "app/serve.ts",
    what: /^\/api(\/|\/v2\/organizations\/\[\^\/\]\+)?$/,
    rule: "transport",
    why: "the installed app's server forwards /api to the server, and names three addresses of the API only to give them longer to answer",
  },
  {
    file: "app/serve.ts",
    what: "fetch()",
    rule: "transport",
    why: "the installed app's server forwarding a call to the server",
  },
  {
    file: "app/vite.config.ts",
    what: "/api",
    rule: "transport",
    why: "the development server's proxy of /api",
  },
  {
    file: "app/src/components/channels/chat-transcript.tsx",
    what: "fetch()",
    rule: "transport",
    why: "asks with HEAD whether a sent document is still there, at the address the generated client builds (getGetAttachmentUrl)",
  },
  {
    file: "mobile/src/api/request.ts",
    what: /^(fetch\(\)|\/api\/|\/api\/v2\/|\/api\/v2\/organizations\/\{\})$/,
    rule: "transport",
    why: "mobile's one request function, the generated client's mutator, which checks it is given an address of the server, keys the API's writes, and recognises where a generated call wrote the organization",
  },
  {
    file: "mobile/src/organization.ts",
    what: /^\/api\/v2\/organizations\/(\{organizationId\}|\{\}\{\})$/,
    rule: "transport",
    why: "fills the organization the person is working in into an address the generated client built, and into the screen socket's",
  },
  {
    file: "extension/src/shared/openbot-client.ts",
    what: "fetch()",
    rule: "transport",
    why: "the Recorder's one request function, the generated client's mutator, with its bearer and no cookies",
  },
  // Sign-in.
  {
    file: "app/src/lib/auth/client.ts",
    what: "fetch()",
    rule: "sign-in-protocol",
    why: "Better Auth's client sends sign-in's own requests (sign-in, SSO, sign-out) through the page's fetch",
  },
  {
    file: "app/src/lib/organizations/queries.ts",
    what: "/api/auth/organization/set-active",
    rule: "sign-in-protocol",
    why: "Better Auth's own address for the organization a session works in, which switching sets",
  },
  {
    file: "app/src/lib/auth/resume.ts",
    what: "/api/plugins/arcade/verify",
    rule: "sign-in-protocol",
    why: "where sign-in sends a person back to finish verifying an app account",
  },
  {
    file: "app/src/lib/plugins/finish-on-return.ts",
    what: "fetch()",
    rule: "sign-in-protocol",
    why: "OpenBot Desktop's window finishes an app account's verification in the background, at the verifier resume.ts names",
  },
  // The runtime and the sockets.
  {
    file: "app/src/lib/copilot/provider.tsx",
    what: "/api/copilotkit",
    rule: "runtime",
    why: "the CopilotKit runtime the app's runs go through",
  },
  {
    file: "app/src/lib/copilot/thread-messages.ts",
    what: "/api/copilotkit/threads/{}/messages?agentId={}",
    rule: "runtime",
    why: "a conversation's stored runs, read back from the runtime to replay them",
  },
  {
    file: "shared/recorder-api.ts",
    what: "/api/copilotkit/trajectory/{}/connect",
    rule: "runtime",
    why: "the runtime's pass for a recording to stream to Intelligence's gateway",
  },
  {
    file: "app/src/lib/socket-url.ts",
    what: "/api/v2/organizations/{}{}",
    rule: "socket",
    why: "the address of the API's sockets (api/asyncapi.yaml)",
  },
  ...[
    "app/src/lib/channels/use-channel-events.ts",
    "app/src/components/computer/live-screen.tsx",
    "app/src/components/computer/live-terminal.tsx",
  ].map(
    (file): Allowed => ({
      file,
      what: "new WebSocket()",
      rule: "socket",
      why: "one of the API's sockets, at the address socket-url.ts builds (api/asyncapi.yaml)",
    }),
  ),
  // Stored data.
  {
    file: "shared/attachments.ts",
    what: "/api/attachments/{}",
    rule: "stored-format",
    why: "the form a sent message keeps its attachment in; the app reads it at the API's address",
  },
  // Clients already released.
  {
    file: "shared/recorder-api.ts",
    what: "/api/recorder/connect-codes",
    rule: "installed-client",
    why: "where released Desktop shells, 1.0.2 and 1.0.3, ask for the connect code they hand a Recorder",
  },
  // Desktop's native side.
  {
    file: "desktop/src-tauri/src/main.rs",
    what: "/api/capabilities",
    rule: "before-sign-in",
    why: "whether a deployment this app manages is already running, and the Recorder host's ping, asked with no credential",
  },
  {
    file: "desktop/src-tauri/src/stack.rs",
    what: "/health",
    rule: "before-sign-in",
    why: "whether the server and the app answer yet",
  },
  {
    file: "desktop/src-tauri/src/host_access.rs",
    what: /^\/api\/host-access\/desktop\/(next|result|shown)$/,
    rule: "machine-credential",
    why: "Desktop's host access, with its host token",
  },
  {
    file: "desktop/src-tauri/src/desktop_connection.rs",
    what: "/api/desktop/connection-failure",
    rule: "machine-credential",
    why: "why the server could not sign in to the model or Intelligence, asked with the host token",
  },
  {
    file: "desktop/src-tauri/src/env.rs",
    what: /^\/api\/(model-provider\/v1|agent-tools\/call)$/,
    rule: "machine-credential",
    why: "the addresses Desktop gives a Bot's harness: the model proxy and the tool callback",
  },
  {
    file: "desktop/src-tauri/src/learning_model.rs",
    what: "/api/learning-model/v1",
    rule: "machine-credential",
    why: "the address Desktop gives Intelligence's Learning for its model",
  },
  {
    file: "desktop/src-tauri/src/recorder_host.rs",
    what: "/api/v2/organizations/default/people/me/recorder-connect-codes",
    rule: "hand-built-v2",
    why: "the Recorder host's handoff, from Rust, which has no generated client",
  },
  {
    file: "desktop/src-tauri/src/install_token.rs",
    what: "/api/install/enter",
    rule: "sign-in-protocol",
    why: "the window enters the OpenBot on this computer once with its install's token",
  },
  {
    file: "scripts/start.sh",
    what: /^\/api\/install\/enter\?token=/,
    rule: "sign-in-protocol",
    why: "the start script prints the address a single-user OpenBot is opened at, with its install's token",
  },
  // Desktop connecting to an OpenBot that runs somewhere else.
  {
    file: "desktop/src-tauri/src/connected/address.rs",
    what: "/api/v2/organizations/default/deployment",
    rule: "hand-built-v2",
    why: "whether the address a person typed is an OpenBot, asked from Rust before anybody signs in",
  },
  {
    file: "desktop/src-tauri/src/connected/address.rs",
    what: "/.well-known/oauth-authorization-server/api/auth",
    rule: "before-sign-in",
    why: "OAuth's discovery document, which names the sign-in's addresses",
  },
  {
    file: "desktop/src-tauri/src/connected/sign_in.rs",
    what: "/api/copilotkit/info",
    rule: "runtime",
    why: "whether the OpenBot serves its runtime to an app's sign-in, asked once after signing in",
  },
  {
    file: "desktop/src-tauri/src/connected/relay.rs",
    what: /^\/(api\/?|\.well-known\/)$/,
    rule: "transport",
    why: "the relay that carries the window's requests to the OpenBot it is connected to: the starts of the paths it signs in, naming no address of its own",
  },
  // Path tables the server registers today's routes from.
  ...["shared/bot-browser.ts", "shared/openbot-browser.ts"].map(
    (file): Allowed => ({
      file,
      what: /^\/api\/(computers\/\{\}\/)?browser(\/|$)/,
      rule: "server-routes",
      why: "today's browser addresses, which the server registers from here and no client calls since the browsers moved onto the generated client",
    }),
  ),
  {
    file: "desktop/src-tauri/src/provider_oauth.rs",
    what: /^\/api\/oauth\/(device_authorization|token)$/,
    rule: "third-party",
    why: "a model provider's own sign-in, at the provider's address",
  },
  // Third parties.
  {
    file: "app/src/lib/voice/websocket.ts",
    what: "new WebSocket()",
    rule: "third-party",
    why: "the voice service's own socket, at the address the API hands out",
  },
  {
    file: "scripts/self-hosted-learning.ts",
    what: /^\/api\/(me|me\/accessible-orgs|organizations\/\{\}\/projects|learning\/projects\/\{\}\/containers|projects\/\{\}\/api-keys)$/,
    rule: "third-party",
    why: "Intelligence's own API, to set up Learning on a self-hosted Intelligence",
  },
  {
    file: "scripts/learning-container.ts",
    what: /^\/api\/(v1\/learning\/containers|learning\/projects\/\{\}\/containers)$/,
    rule: "third-party",
    why: "Intelligence's own API, to make a Learning container",
  },
  {
    file: "scripts/downloads-images.ts",
    what: "fetch()",
    rule: "third-party",
    why: "image registries, never OpenBot's server",
  },
  // Scripts that run and stop a server on this machine.
  {
    file: "scripts/update-local.ts",
    what: /^(\/health|\/release|fetch\(\))$/,
    rule: "before-sign-in",
    why: "whether an updated server answers, and which release it runs",
  },
  {
    file: "scripts/start.sh",
    what: "/health",
    rule: "before-sign-in",
    why: "whether the server and the Bot computer answer yet",
  },
  {
    file: "scripts/start.sh",
    what: "/api/copilotkit/info",
    rule: "runtime",
    why: "whether the port answers as OpenBot, and which Bots it runs",
  },
  {
    file: "scripts/stop.sh",
    what: "/api/copilotkit/info",
    rule: "runtime",
    why: "whether the port answers as OpenBot before stopping it",
  },
  {
    file: "scripts/start.sh",
    what: "/api/agent-tools/call",
    rule: "machine-credential",
    why: "the tool callback address start gives a Bot's harness",
  },
];

/**
 * Today's calls made by hand that are moving onto the API. Each change that moves one deletes its
 * entry here; the test then fails if the call is still made by hand.
 */
export const TEMPORARY: Temporary[] = [];
