import { describe, expect, test } from "bun:test";
import {
  type AppScene,
  isApiRoute,
  isAppScene,
  parseApiAnswer,
} from "./appContract";

describe("isApiRoute", () => {
  test("takes a method and a path under /api", () => {
    expect(isApiRoute("GET /api/v2/organizations/:organizationId/bots")).toBe(
      true,
    );
    expect(isApiRoute("ALL /api/*")).toBe(true);
    expect(isApiRoute("DELETE /api/")).toBe(true);
  });

  test("refuses a wrong method", () => {
    expect(isApiRoute("HEAD /api/v2/me")).toBe(false);
    expect(isApiRoute("get /api/v2/me")).toBe(false);
  });

  test("refuses a path that is not under /api", () => {
    expect(isApiRoute("GET /v2/me")).toBe(false);
    expect(isApiRoute("GET api/v2/me")).toBe(false);
  });

  test("refuses spaces", () => {
    expect(isApiRoute("GET /api/v2/my bots")).toBe(false);
    expect(isApiRoute("GET  /api/v2/me")).toBe(false);
    expect(isApiRoute(" GET /api/v2/me")).toBe(false);
  });
});

describe("parseApiAnswer", () => {
  test("value", () => {
    expect(parseApiAnswer({ mode: "value", body: { a: 1 } })).toEqual({
      mode: "value",
      body: { a: 1 },
    });
    expect(parseApiAnswer({ mode: "value", status: 201, body: null })).toEqual({
      mode: "value",
      status: 201,
      body: null,
    });
    expect(parseApiAnswer({ mode: "value" })).toBeNull();
  });

  test("never", () => {
    expect(parseApiAnswer({ mode: "never" })).toEqual({ mode: "never" });
  });

  test("fail", () => {
    expect(parseApiAnswer({ mode: "fail", status: 500 })).toEqual({
      mode: "fail",
      status: 500,
    });
    expect(
      parseApiAnswer({ mode: "fail", status: 403, body: { detail: "No." } }),
    ).toEqual({ mode: "fail", status: 403, body: { detail: "No." } });
    expect(parseApiAnswer({ mode: "fail" })).toBeNull();
  });

  test("delay", () => {
    expect(parseApiAnswer({ mode: "delay", ms: 300, body: [] })).toEqual({
      mode: "delay",
      ms: 300,
      body: [],
    });
    expect(
      parseApiAnswer({ mode: "delay", ms: 0, status: 202, body: "ok" }),
    ).toEqual({ mode: "delay", ms: 0, status: 202, body: "ok" });
    expect(parseApiAnswer({ mode: "delay", ms: 300 })).toBeNull();
  });

  test("offline", () => {
    expect(parseApiAnswer({ mode: "offline" })).toEqual({ mode: "offline" });
  });

  test("a bad status", () => {
    expect(parseApiAnswer({ mode: "fail", status: 99 })).toBeNull();
    expect(parseApiAnswer({ mode: "fail", status: 600 })).toBeNull();
    expect(parseApiAnswer({ mode: "fail", status: 404.5 })).toBeNull();
    expect(parseApiAnswer({ mode: "fail", status: "404" })).toBeNull();
    expect(parseApiAnswer({ mode: "value", status: 0, body: 1 })).toBeNull();
  });

  test("a negative or endless ms", () => {
    expect(parseApiAnswer({ mode: "delay", ms: -1, body: 1 })).toBeNull();
    expect(
      parseApiAnswer({ mode: "delay", ms: Number.POSITIVE_INFINITY, body: 1 }),
    ).toBeNull();
    expect(parseApiAnswer({ mode: "delay", ms: "5", body: 1 })).toBeNull();
  });

  test("an unknown mode or not an object", () => {
    expect(parseApiAnswer({ mode: "script" })).toBeNull();
    expect(parseApiAnswer({})).toBeNull();
    expect(parseApiAnswer(null)).toBeNull();
    expect(parseApiAnswer("value")).toBeNull();
    expect(parseApiAnswer([])).toBeNull();
  });
});

describe("isAppScene", () => {
  const good: AppScene = {
    kind: "app",
    id: "app-home-bots",
    title: "Home with bots",
    group: "App",
    start: {
      route: "/",
      host: "desktop",
      session: {
        signedIn: true,
        role: "owner",
        name: "Sam Rivera",
        email: "sam@example.com",
        organization: { id: "org-1", name: "Example" },
        onboarded: true,
      },
    },
  };

  function withField(path: string[], value: unknown): unknown {
    const copy = structuredClone(good) as unknown as Record<string, unknown>;
    let target = copy;
    for (const key of path.slice(0, -1)) {
      target = target[key] as Record<string, unknown>;
    }
    const last = path[path.length - 1] as string;
    if (value === undefined) delete target[last];
    else target[last] = value;
    return copy;
  }

  test("takes a view with initial configuration", () => {
    expect(isAppScene(good)).toBe(true);
  });

  test("refuses each bad field", () => {
    const bad: [string[], unknown][] = [
      [["kind"], "desktop"],
      [["kind"], undefined],
      [["id"], 1],
      [["title"], undefined],
      [["group"], "Install"],
      [["start"], undefined],
      [["start"], "/"],
      [["start", "route"], "home"],
      [["start", "route"], 1],
      [["start", "host"], "phone"],
      [["start", "host"], undefined],
      [["start", "session"], undefined],
      [["start", "session"], true],
    ];
    for (const [path, value] of bad) {
      expect({ path, ok: isAppScene(withField(path, value)) }).toEqual({
        path,
        ok: false,
      });
    }
  });

  test("refuses what is not an object", () => {
    expect(isAppScene(null)).toBe(false);
    expect(isAppScene([])).toBe(false);
    expect(isAppScene("app")).toBe(false);
  });
});
