import { describe, expect, test } from "bun:test";
import type { HandoffMode } from "../src/logic/handoffConfig";
import {
  type Config,
  decideNavigation,
  type Effect,
  type Event,
  initialState,
  MESSAGES,
  reduce,
  showsLock,
  showsSignInScreen,
  showsSkeleton,
  showsTabBar,
  type State,
  webMounted,
} from "../src/logic/machine";

const config: Config = {
  origin: "https://my.open.bot",
  platform: "ios",
  handoffAuto: false,
};
const pair = { verifier: "v".repeat(43), challenge: "c".repeat(43) };
const T = "T".repeat(43);

/** Runs events in order; time advances 10 ms per event unless the event says otherwise. */
function run(
  events: (Event | [Event, number])[],
  start: State = initialState(),
) {
  let state = start;
  let at = 1_000;
  const effects: Effect[] = [];
  for (const item of events) {
    const [event, when] = Array.isArray(item) ? item : [item, at + 10];
    at = when;
    const step = reduce(config, state, event, at);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects, at };
}

const scheme: HandoffMode = { kind: "scheme" };
const signedOut = () => run([{ type: "launch", hasSession: false }]).state;
const ownDocDrawn = (path = "/"): Event[] => [
  { type: "urlChanged", url: `https://my.open.bot${path}`, canGoBack: false },
  { type: "page", message: { kind: "doc", late: false } },
  { type: "loadEnd", url: `https://my.open.bot${path}` },
  { type: "page", message: { kind: "bridge", message: { type: "ready" } } },
  { type: "page", message: { kind: "text", body: 300, main: 120 } },
  {
    type: "page",
    message: {
      kind: "bridge",
      message: { type: "route", path, tab: "home", signedIn: true },
    },
  },
];
function signedIn(): State {
  const launched = run([
    { type: "launch", hasSession: true },
    ...ownDocDrawn(),
  ]);
  return run([{ type: "timer", name: "hideSkeleton" }], launched.state).state;
}

describe("launch", () => {
  test("with a session: tabs, the web view loading the app under the skeleton", () => {
    const { state } = run([{ type: "launch", hasSession: true }]);
    expect(state.phase).toBe("signedIn");
    expect(state.source?.uri).toBe("https://my.open.bot/");
    expect(showsSkeleton(state)).toBe(true);
    expect(showsTabBar(state)).toBe(true);
  });
  test("without: the native first screen, no web view", () => {
    const state = signedOut();
    expect(showsSignInScreen(state)).toBe(true);
    expect(webMounted(state)).toBe(false);
  });
});

describe("sign-in through the system sheet", () => {
  test("config, sheet, ticket, enter with the header, finished by the page's route", () => {
    let { state, effects } = run([{ type: "signInPressed" }], signedOut());
    expect(state.signIn).toBe("probing");
    expect(effects).toContainEqual({ type: "fetchConfig", purpose: "sign-in" });
    ({ state, effects } = run(
      [{ type: "configAnswered", mode: scheme, pair }],
      state,
    ));
    expect(state.signIn).toBe("sheet");
    const open = effects.find((e) => e.type === "openSheet");
    expect(open && "url" in open ? open.url : "").toBe(
      `https://my.open.bot/api/auth/shell/handoff?challenge=${pair.challenge}&platform=ios&callback=scheme`,
    );
    ({ state, effects } = run(
      [
        {
          type: "sheetResult",
          result: "success",
          url: `openbotshell://signed-in?ticket=${T}`,
        },
      ],
      state,
    ));
    expect(state.signIn).toBe("entering");
    expect(state.source).toEqual({
      uri: `https://my.open.bot/api/auth/shell/enter?ticket=${T}&verifier=${pair.verifier}&to=%2F`,
      headers: { "OpenBot-Shell": "ios" },
    });
    expect(showsSkeleton(state)).toBe(true);
    expect(showsSignInScreen(state)).toBe(false);
    // Never kept as a page to reload.
    expect(state.lastOwnUrl).toBe("https://my.open.bot/");
    ({ state } = run(ownDocDrawn(), state));
    expect(state.phase).toBe("signedIn");
    expect(state.pending).toBeNull();
  });

  test("finishing does not depend on the bridge: own URL, not /sign or /api, and the cookie", () => {
    let { state } = run(
      [
        { type: "signInPressed" },
        { type: "configAnswered", mode: scheme, pair },
        {
          type: "sheetResult",
          result: "success",
          url: `openbotshell://signed-in?ticket=${T}`,
        },
      ],
      signedOut(),
    );
    let effects: Effect[];
    ({ state, effects } = run(
      [
        {
          type: "urlChanged",
          url: "https://my.open.bot/api/auth/shell/enter?ticket=x",
          canGoBack: false,
        },
      ],
      state,
    ));
    expect(effects.some((e) => e.type === "checkSession")).toBe(false);
    ({ state, effects } = run(
      [{ type: "urlChanged", url: "https://my.open.bot/", canGoBack: false }],
      state,
    ));
    expect(effects).toContainEqual({
      type: "checkSession",
      reason: "entering-url",
    });
    ({ state } = run(
      [{ type: "sessionChecked", reason: "entering-url", present: true }],
      state,
    ));
    expect(state.phase).toBe("signedIn");
  });

  test("timeout checks the session before failing", () => {
    const entering = run(
      [
        { type: "signInPressed" },
        { type: "configAnswered", mode: scheme, pair },
        {
          type: "sheetResult",
          result: "success",
          url: `openbotshell://signed-in?ticket=${T}`,
        },
        { type: "timer", name: "enter" },
      ],
      signedOut(),
    );
    expect(entering.effects).toContainEqual({
      type: "checkSession",
      reason: "enter-timeout",
    });
    expect(
      run(
        [{ type: "sessionChecked", reason: "enter-timeout", present: true }],
        entering.state,
      ).state.phase,
    ).toBe("signedIn");
    const failed = run(
      [{ type: "sessionChecked", reason: "enter-timeout", present: false }],
      entering.state,
    ).state;
    expect(failed.phase).toBe("signedOut");
    expect(failed.message).toBe(MESSAGES.tooLong);
    expect(webMounted(failed)).toBe(false);
  });

  test("a callback without a well-formed ticket does not cancel the pending sign-in (Android)", () => {
    const android: Config = { ...config, platform: "android" };
    let state = run([{ type: "launch", hasSession: false }]).state;
    for (const event of [
      { type: "signInPressed" },
      { type: "configAnswered", mode: scheme, pair },
      { type: "callbackUrl", url: "openbotshell://signed-in?ticket=" },
      { type: "callbackUrl", url: "openbotshell://signed-in" },
      { type: "callbackUrl", url: "openbotshell://evil?ticket=" + T },
    ] as Event[]) {
      state = reduce(android, state, event, 2_000).state;
    }
    expect(state.signIn).toBe("sheet");
    expect(state.pending).not.toBeNull();
    state = reduce(
      android,
      state,
      { type: "callbackUrl", url: `openbotshell://signed-in?ticket=${T}` },
      2_100,
    ).state;
    expect(state.signIn).toBe("entering");
  });

  test("a callback with no sign-in pending is ignored", () => {
    const { state } = run(
      [{ type: "callbackUrl", url: `openbotshell://signed-in?ticket=${T}` }],
      signedOut(),
    );
    expect(state.signIn).toBe("idle");
    expect(state.source).toBeNull();
  });

  test("closing the sheet returns quietly; config unreachable locks; 404 opens the web sign-in", () => {
    const cancelled = run(
      [
        { type: "signInPressed" },
        { type: "configAnswered", mode: scheme, pair },
        { type: "sheetResult", result: "cancel", url: null },
      ],
      signedOut(),
    ).state;
    expect(cancelled.signIn).toBe("idle");
    expect(cancelled.message).toBeNull();
    const locked = run(
      [
        { type: "signInPressed" },
        {
          type: "configAnswered",
          mode: { kind: "unreachable", reason: "x" },
          pair,
        },
      ],
      signedOut(),
    ).state;
    expect(showsLock(locked)).toBe(true);
    expect(locked.failureSource).toBe("signIn");
    const web = run(
      [
        { type: "signInPressed" },
        {
          type: "configAnswered",
          mode: { kind: "webSignIn", reason: "status-404" },
          pair,
        },
      ],
      signedOut(),
    ).state;
    expect(web.signIn).toBe("webFallback");
    expect(web.source?.uri).toBe("https://my.open.bot/sign?native-sign-in=web");
    expect(web.source?.headers).toBeUndefined();
  });

  test("web sign-in finishes on the cookie, with a new web view (no history back to /sign)", () => {
    let { state } = run(
      [
        { type: "signInPressed" },
        {
          type: "configAnswered",
          mode: { kind: "webSignIn", reason: "x" },
          pair,
        },
      ],
      signedOut(),
    );
    const key = state.webKey;
    ({ state } = run(
      [
        { type: "urlChanged", url: "https://my.open.bot/", canGoBack: true },
        { type: "sessionChecked", reason: "web-fallback-url", present: true },
      ],
      state,
    ));
    expect(state.phase).toBe("signedIn");
    expect(state.webKey).toBe(key + 1);
  });
});

describe("signed in", () => {
  test("the skeleton waits for ready and text in <main>", () => {
    let { state, effects } = run([
      { type: "launch", hasSession: true },
      { type: "urlChanged", url: "https://my.open.bot/", canGoBack: false },
      { type: "page", message: { kind: "doc", late: false } },
    ]);
    ({ state, effects } = run(
      [
        {
          type: "page",
          message: { kind: "bridge", message: { type: "ready" } },
        },
      ],
      state,
    ));
    expect(
      effects.some((e) => e.type === "timer" && e.name === "hideSkeleton"),
    ).toBe(false);
    ({ state, effects } = run(
      [{ type: "page", message: { kind: "text", body: 30, main: 25 } }],
      state,
    ));
    expect(
      effects.some((e) => e.type === "timer" && e.name === "hideSkeleton"),
    ).toBe(true);
    ({ state } = run([{ type: "timer", name: "hideSkeleton" }], state));
    expect(showsSkeleton(state)).toBe(false);
  });

  test("without the bridge: text after the finish, then gone", () => {
    let { state, effects } = run([
      { type: "launch", hasSession: true },
      { type: "urlChanged", url: "https://my.open.bot/", canGoBack: false },
      { type: "loadEnd", url: "https://my.open.bot/" },
    ]);
    expect(
      effects.some((e) => e.type === "timer" && e.name === "noReady"),
    ).toBe(true);
    ({ state, effects } = run(
      [
        { type: "page", message: { kind: "text", body: 10, main: 3 } },
        { type: "timer", name: "noReady" },
      ],
      state,
    ));
    expect(
      effects.some((e) => e.type === "timer" && e.name === "hideSkeleton"),
    ).toBe(true);
  });

  test("tabs dispatch openbot:open when the page is up, load otherwise", () => {
    const state = signedIn();
    const { effects, state: after } = run(
      [{ type: "tabPressed", tab: "bots" }],
      state,
    );
    expect(effects).toContainEqual({ type: "dismissKeyboard" });
    expect(effects.find((e) => e.type === "inject")).toEqual({
      type: "inject",
      script:
        'window.__openbotShellOpen && window.__openbotShellOpen("/bots"); true;',
    });
    expect(after.tab).toBe("bots");
    const notReady = run([
      { type: "launch", hasSession: true },
      { type: "tabPressed", tab: "conversations" },
    ]).state;
    expect(notReady.source?.uri).toBe("https://my.open.bot/conversations");
  });

  test("route messages select the tab", () => {
    const { state } = run(
      [
        {
          type: "page",
          message: {
            kind: "bridge",
            message: {
              type: "route",
              path: "/channel/x",
              tab: "conversations",
              signedIn: true,
            },
          },
        },
      ],
      signedIn(),
    );
    expect(state.tab).toBe("conversations");
  });

  test("signed-out returns to the first screen and clears the site's data", () => {
    const { state, effects } = run(
      [
        {
          type: "page",
          message: { kind: "bridge", message: { type: "signed-out" } },
        },
      ],
      signedIn(),
    );
    expect(state.phase).toBe("signedOut");
    expect(webMounted(state)).toBe(false);
    expect(effects).toContainEqual({ type: "clearSiteData" });
    expect(effects).toContainEqual({ type: "dismissKeyboard" });
  });

  test("after `ready`, arriving at /sign alone does not sign out: route then a cookie check", () => {
    let { state, effects } = run(
      [
        {
          type: "urlChanged",
          url: "https://my.open.bot/sign",
          canGoBack: false,
        },
      ],
      signedIn(),
    );
    expect(state.phase).toBe("signedIn");
    expect(
      effects.some((e) => e.type === "timer" && e.name === "signConfirm"),
    ).toBe(false);
    ({ state, effects } = run(
      [
        {
          type: "page",
          message: {
            kind: "bridge",
            message: {
              type: "route",
              path: "/sign",
              tab: null,
              signedIn: false,
            },
          },
        },
      ],
      state,
    ));
    expect(
      effects.some((e) => e.type === "timer" && e.name === "signConfirm"),
    ).toBe(true);
    ({ state, effects } = run([{ type: "timer", name: "signConfirm" }], state));
    expect(effects).toContainEqual({
      type: "checkSession",
      reason: "sign-confirm",
    });
    expect(
      run(
        [
          { type: "urlChanged", url: "https://my.open.bot/", canGoBack: false },
          { type: "sessionChecked", reason: "sign-confirm", present: true },
        ],
        state,
      ).state.phase,
    ).toBe("signedIn");
    expect(
      run(
        [{ type: "sessionChecked", reason: "sign-confirm", present: true }],
        state,
      ).state.phase,
    ).toBe("signedOut");
  });

  test("without the bridge, /sign starts the confirmation", () => {
    const launched = run([
      { type: "launch", hasSession: true },
      { type: "urlChanged", url: "https://my.open.bot/sign", canGoBack: false },
    ]);
    expect(
      launched.effects.some(
        (e) => e.type === "timer" && e.name === "signConfirm",
      ),
    ).toBe(true);
  });

  test("own-origin failures lock (5xx too); retry loads the last own page in a new web view", () => {
    let state = run(
      [
        {
          type: "urlChanged",
          url: "https://my.open.bot/bots",
          canGoBack: true,
        },
      ],
      signedIn(),
    ).state;
    state = run(
      [{ type: "httpError", url: "https://my.open.bot/bots", status: 502 }],
      state,
    ).state;
    expect(showsLock(state)).toBe(true);
    const key = state.webKey;
    const retried = run([{ type: "retry", automatic: false }], state).state;
    expect(retried.webKey).toBe(key + 1);
    expect(retried.source?.uri).toBe("https://my.open.bot/bots");
    const lifted = run(
      [{ type: "page", message: { kind: "doc", late: false } }],
      retried,
    ).state;
    expect(showsLock(lifted)).toBe(false);
  });

  test("the error page after a failure does not lift the lock", () => {
    let state = run(
      [{ type: "httpError", url: "https://my.open.bot/", status: 502 }],
      signedIn(),
    ).state;
    state = run(
      [
        { type: "page", message: { kind: "doc", late: false } },
        { type: "loadEnd", url: "https://my.open.bot/" },
        { type: "page", message: { kind: "doc", late: true } },
      ],
      state,
    ).state;
    expect(showsLock(state)).toBe(true);
    expect(showsSkeleton(state)).toBe(false);
  });

  test("another site's failure goes back to the app instead of locking", () => {
    let state = run(
      [
        {
          type: "urlChanged",
          url: "https://my.open.bot/bots",
          canGoBack: true,
        },
      ],
      signedIn(),
    ).state;
    state = run(
      [
        { type: "navStart", url: "https://idp.example/x" },
        {
          type: "loadError",
          url: "https://idp.example/x",
          code: -1004,
          description: "x",
        },
      ],
      state,
    ).state;
    expect(showsLock(state)).toBe(false);
    expect(state.source?.uri).toBe("https://my.open.bot/bots");
    const http = run(
      [{ type: "httpError", url: "https://idp.example/x", status: 503 }],
      signedIn(),
    ).state;
    expect(showsLock(http)).toBe(false);
  });

  test("the watchdog locks a load that never answers", () => {
    const { state } = run([
      { type: "launch", hasSession: true },
      { type: "timer", name: "watchdog" },
    ]);
    expect(showsLock(state)).toBe(true);
    expect(showsSkeleton(state)).toBe(false);
  });

  test("offline locks, and coming back retries", () => {
    let { state, effects } = run(
      [{ type: "network", offline: true }],
      signedIn(),
    );
    expect(showsLock(state)).toBe(true);
    expect(effects).toContainEqual({ type: "dismissKeyboard" });
    ({ state } = run([{ type: "network", offline: false }], state));
    expect(showsLock(state)).toBe(false);
  });

  test("the web content process dying: skeleton and a new web view at the last own page", () => {
    const before = run(
      [
        {
          type: "urlChanged",
          url: "https://my.open.bot/bots/b1",
          canGoBack: true,
        },
      ],
      signedIn(),
    ).state;
    const { state } = run([{ type: "processGone" }], before);
    expect(state.webKey).toBe(before.webKey + 1);
    expect(state.source?.uri).toBe("https://my.open.bot/bots/b1");
    expect(showsSkeleton(state)).toBe(true);
  });

  test("a restart never reloads enter", () => {
    const entering = run(
      [
        { type: "signInPressed" },
        { type: "configAnswered", mode: scheme, pair },
        {
          type: "sheetResult",
          result: "success",
          url: `openbotshell://signed-in?ticket=${T}`,
        },
      ],
      signedOut(),
    ).state;
    const restarted = run([{ type: "processGone" }], entering).state;
    expect(restarted.source?.uri).toBe("https://my.open.bot/");
    expect(restarted.source?.headers).toBeUndefined();
  });

  test("the hosted sign-in's renewal goes to the sheet and comes back to returnTo", () => {
    const state = signedIn();
    const url =
      "https://my.open.bot/api/auth/hosted/sign-in?returnTo=https%3A%2F%2Fmy.open.bot%2Fbots%2Fb1%3Ftab%3Dchat%26openbot-renewed%3D1";
    const decision = decideNavigation(
      config,
      state,
      { url, isTopFrame: true },
      5_000,
    );
    expect(decision.allow).toBe(false);
    let { state: renewing, effects } = run(decision.events, state);
    expect(effects).toContainEqual({
      type: "fetchConfig",
      purpose: "renewal",
      to: "/bots/b1?tab=chat&openbot-renewed=1",
      intercepted: url,
    });
    const https: HandoffMode = {
      kind: "https",
      host: "my.open.bot",
      path: "/api/auth/shell/callback",
      url: "https://my.open.bot/api/auth/shell/callback",
    };
    ({ state: renewing, effects } = run(
      [
        {
          type: "renewalConfigAnswered",
          mode: https,
          pair,
          to: "/bots/b1?tab=chat&openbot-renewed=1",
          intercepted: url,
        },
      ],
      renewing,
    ));
    const open = effects.find((e) => e.type === "openSheet");
    expect(open && "url" in open ? open.url : "").toBe(
      `https://my.open.bot/api/auth/hosted/sign-in?returnTo=%2Fapi%2Fauth%2Fshell%2Fhandoff%3Fchallenge%3D${pair.challenge}%26platform%3Dios%26callback%3Dhttps`,
    );
    ({ state: renewing } = run(
      [
        {
          type: "sheetResult",
          result: "success",
          url: `https://my.open.bot/api/auth/shell/callback?ticket=${T}`,
        },
      ],
      renewing,
    ));
    expect(renewing.phase).toBe("signedIn");
    expect(renewing.source?.uri).toBe(
      `https://my.open.bot/api/auth/shell/enter?ticket=${T}&verifier=${pair.verifier}&to=%2Fbots%2Fb1%3Ftab%3Dchat%26openbot-renewed%3D1`,
    );
    expect(renewing.source?.headers).toEqual({ "OpenBot-Shell": "ios" });
  });
});

describe("navigation policy", () => {
  const at = 10_000;
  test("openbotshell:// never loads; schemes only from a tap, only mailto, tel, sms", () => {
    const state = signedIn();
    expect(
      decideNavigation(
        config,
        state,
        {
          url: `openbotshell://signed-in?ticket=${T}`,
          navigationType: "click",
        },
        at,
      ).allow,
    ).toBe(false);
    const mail = decideNavigation(
      config,
      state,
      {
        url: "mailto:support@open.bot",
        navigationType: "click",
        isTopFrame: true,
      },
      at,
    );
    expect(mail).toEqual({
      allow: false,
      events: [{ type: "openExternal", url: "mailto:support@open.bot" }],
    });
    expect(
      decideNavigation(
        config,
        state,
        { url: "mailto:x@y.z", navigationType: "other", isTopFrame: true },
        at,
      ).events[0].type,
    ).toBe("blocked");
    expect(
      decideNavigation(
        config,
        state,
        { url: "mailto:x@y.z", navigationType: "click", isTopFrame: false },
        at,
      ).events[0].type,
    ).toBe("blocked");
    expect(
      decideNavigation(
        config,
        state,
        { url: "intent://x#Intent;end", hasGesture: true },
        at,
      ).events[0].type,
    ).toBe("blocked");
    expect(
      decideNavigation(
        config,
        state,
        { url: "javascript:alert(1)", navigationType: "click" },
        at,
      ).allow,
    ).toBe(false);
    // Android: no gesture on the request, but the page reported a tap just now.
    const tapped = run(
      [[{ type: "page", message: { kind: "tap" } }, at - 200]],
      state,
    ).state;
    expect(
      decideNavigation(config, tapped, { url: "tel:+100" }, at).events[0].type,
    ).toBe("openExternal");
    expect(
      decideNavigation(config, tapped, { url: "tel:+100" }, at + 5_000)
        .events[0].type,
    ).toBe("blocked");
  });
  test("tapped links to other sites open in the in-app browser; script navigations and iframes load", () => {
    const state = signedIn();
    expect(
      decideNavigation(
        config,
        state,
        {
          url: "https://github.com/x",
          navigationType: "click",
          isTopFrame: true,
        },
        at,
      ),
    ).toEqual({
      allow: false,
      events: [{ type: "openBrowser", url: "https://github.com/x" }],
    });
    expect(
      decideNavigation(
        config,
        state,
        {
          url: "https://idp.example/",
          navigationType: "other",
          isTopFrame: true,
        },
        at,
      ).allow,
    ).toBe(true);
    expect(
      decideNavigation(
        config,
        state,
        {
          url: "https://challenges.cloudflare.com/x",
          navigationType: "click",
          isTopFrame: false,
        },
        at,
      ).allow,
    ).toBe(true);
    expect(
      decideNavigation(
        config,
        state,
        {
          url: "https://my.open.bot/bots",
          navigationType: "click",
          isTopFrame: true,
        },
        at,
      ).allow,
    ).toBe(true);
  });
  test("back never leaves the app or reaches /sign once signed in", () => {
    const state = signedIn();
    expect(
      decideNavigation(
        config,
        state,
        {
          url: "https://idp.example/",
          navigationType: "backforward",
          isTopFrame: true,
        },
        at,
      ).allow,
    ).toBe(false);
    expect(
      decideNavigation(
        config,
        state,
        {
          url: "https://my.open.bot/sign",
          navigationType: "backforward",
          isTopFrame: true,
        },
        at,
      ).allow,
    ).toBe(false);
    expect(
      decideNavigation(
        config,
        state,
        {
          url: "https://my.open.bot/bots",
          navigationType: "backforward",
          isTopFrame: true,
        },
        at,
      ).allow,
    ).toBe(true);
  });
  test("window.open: own pages in the web view, other sites in the browser after a tap, the rest dropped", () => {
    const state = run(
      [[{ type: "page", message: { kind: "tap" } }, 9_900]],
      signedIn(),
    ).state;
    const own = reduce(
      config,
      state,
      { type: "openWindow", url: "https://my.open.bot/bots" },
      at,
    );
    expect(own.effects.find((e) => e.type === "inject")).toBeTruthy();
    expect(
      reduce(
        config,
        state,
        { type: "openWindow", url: "https://x.example/" },
        at,
      ).effects,
    ).toContainEqual({ type: "openBrowser", url: "https://x.example/" });
    expect(
      reduce(
        config,
        state,
        { type: "openWindow", url: "about:blank" },
        at,
      ).effects.some((e) => e.type === "openBrowser" || e.type === "inject"),
    ).toBe(false);
    expect(
      reduce(
        config,
        state,
        { type: "openWindow", url: "https://x.example/" },
        at + 10_000,
      ).effects.some((e) => e.type === "openBrowser"),
    ).toBe(false);
  });
  test("downloads go to the share sheet, never in place of the page", () => {
    const { effects, state } = run(
      [{ type: "fileDownload", url: "https://my.open.bot/export.csv" }],
      signedIn(),
    );
    expect(effects).toContainEqual({
      type: "share",
      url: "https://my.open.bot/export.csv",
    });
    expect(state.source?.uri).toBe("https://my.open.bot/");
  });
});
