import { expect, test } from "bun:test";
import {
  intelligenceApiOrigin,
  type SetupBrowser,
  setupSelfHostedLearning,
} from "./self-hosted-learning";

const apiUrl = "https://intelligence.example";
const path = "/api/learning/projects/12/containers";
const container = {
  container: { id: "openbot", projectId: 12, name: "OpenBot" },
};
type Response = { status: number; body: unknown };

function fixture(
  override?: (url: string, method: string) => Response | undefined,
) {
  const calls: {
    url: string;
    method: string;
    data?: Record<string, string>;
  }[] = [];
  const navigations: string[] = [];
  let closed = 0;
  const browser: SetupBrowser = {
    navigate: async (url) => {
      navigations.push(url);
    },
    request: async (url, options) => {
      expect(new URL(url).origin).toBe(apiUrl);
      expect(options.headers.Origin).toBe(apiUrl);
      expect(options.headers).not.toHaveProperty("Authorization");
      expect(options.maxRedirects).toBe(0);
      calls.push({ url, method: options.method, data: options.data });
      const response = override?.(new URL(url).pathname, options.method);
      if (response) return response;
      const route = new URL(url).pathname;
      if (route === "/api/me")
        return { status: 200, body: { principal: { id: "user" } } };
      if (route === "/api/me/accessible-orgs")
        return { status: 200, body: { organizations: [{ id: "org-a" }] } };
      if (route === "/api/organizations/org-a/projects")
        return {
          status: 200,
          body: { projects: [{ id: 12, name: "Research" }] },
        };
      if (route === `${path}/openbot`)
        return { status: 200, body: { container: null } };
      if (route === path) return { status: 201, body: container };
      if (route === "/api/projects/12/api-keys")
        return {
          status: 201,
          body: { key: { id: 10, token: "cpk-synthetic-key" } },
        };
      throw new Error(`Unexpected test route ${route}`);
    },
    close: async () => {
      closed += 1;
    },
  };
  return {
    browser,
    calls,
    navigations,
    closed: () => closed,
    options: {
      apiUrl,
      openBrowser: async () => browser,
      selectProject: async (projects: { id: string; name: string }[]) => {
        expect(projects).toEqual([{ id: "12", name: "Research" }]);
        return "12";
      },
      pollIntervalMs: 1,
    },
  };
}

test("fresh browser setup creates a verified container before minting its project key", async () => {
  const f = fixture();
  expect(await setupSelfHostedLearning(f.options)).toEqual({
    apiUrl,
    apiKey: "cpk-synthetic-key",
    learningContainerId: "openbot",
  });
  const signIn = new URL(f.navigations[0]);
  expect(signIn.pathname).toBe("/auth/signin");
  expect(signIn.searchParams.get("callbackUrl")).toBe(`${apiUrl}/`);
  expect(f.calls.filter((call) => call.method === "POST")).toEqual([
    {
      url: `${apiUrl}${path}`,
      method: "POST",
      data: { id: "openbot", name: "OpenBot" },
    },
    {
      url: `${apiUrl}/api/projects/12/api-keys`,
      method: "POST",
      data: { name: "OpenBot" },
    },
  ]);
  expect(f.closed()).toBe(1);
});

test("existing containers are reused and an exact create race is re-read once", async () => {
  for (const race of [false, true]) {
    let reads = 0;
    const f = fixture((route) => {
      if (route === `${path}/openbot`) {
        reads += 1;
        return {
          status: 200,
          body: race && reads === 1 ? { container: null } : container,
        };
      }
      if (route === path)
        return {
          status: 409,
          body: { error: { code: "LEARNING_CONTAINER_ALREADY_EXISTS" } },
        };
    });
    await setupSelfHostedLearning(f.options);
    expect(reads).toBe(race ? 2 : 1);
    expect(
      f.calls.filter((call) => call.url === `${apiUrl}${path}`),
    ).toHaveLength(race ? 1 : 0);
  }
});

test("wrong-project, forbidden, redirected, and unrelated conflict responses never mint a key", async () => {
  for (const response of [
    { status: 200, body: { container: { id: "openbot", projectId: 99 } } },
    { status: 403, body: { error: { message: "secret-response" } } },
    { status: 302, body: null },
    { status: 409, body: { error: { code: "OTHER_CONFLICT" } } },
  ]) {
    const f = fixture((route) =>
      route === `${path}/openbot` ? response : undefined,
    );
    await expect(setupSelfHostedLearning(f.options)).rejects.toThrow(
      "could not be verified",
    );
    expect(f.calls.some((call) => call.url.endsWith("api-keys"))).toBe(false);
    expect(f.closed()).toBe(1);
  }
});

test("authentication waits for a principal and never treats an empty session as signed in", async () => {
  let attempts = 0;
  const f = fixture((route) => {
    if (route === "/api/me" && ++attempts < 3)
      return { status: 200, body: { principal: null } };
  });
  await setupSelfHostedLearning(f.options);
  expect(attempts).toBe(3);
});

test("only accessible projects can be selected, and Learning denial blocks writes", async () => {
  const unknown = fixture();
  await expect(
    setupSelfHostedLearning({
      ...unknown.options,
      selectProject: async () => "99",
    }),
  ).rejects.toThrow("accessible");
  expect(unknown.calls.some((call) => call.method === "POST")).toBe(false);
  const denied = fixture((route) =>
    route === `${path}/openbot` ? { status: 403, body: null } : undefined,
  );
  await expect(setupSelfHostedLearning(denied.options)).rejects.toThrow(
    "could not be verified",
  );
  expect(denied.calls.some((call) => call.method === "POST")).toBe(false);
});

test("cancellation and timeout close the owned browser while waiting for sign-in", async () => {
  for (const mode of ["cancel", "timeout"]) {
    const controller = new AbortController();
    const f = fixture((route) => {
      if (route !== "/api/me") return;
      if (mode === "cancel") controller.abort();
      return { status: 401, body: null };
    });
    await expect(
      setupSelfHostedLearning({
        ...f.options,
        signal: controller.signal,
        timeoutMs: mode === "timeout" ? 5 : 1000,
      }),
    ).rejects.toThrow(mode === "timeout" ? "timed out" : "cancelled");
    expect(f.closed()).toBe(1);
    expect(f.calls.some((call) => call.method === "POST")).toBe(false);
  }
});

test("browser errors cannot expose cookie or response details", async () => {
  const f = fixture();
  f.browser.request = async () => {
    throw new Error("Cookie=secret-cookie response=secret-token");
  };
  let message = "";
  try {
    await setupSelfHostedLearning(f.options);
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("browser setup failed");
  expect(message).not.toContain("secret");
  expect(f.closed()).toBe(1);
});

test("browser cleanup failures are sanitized", async () => {
  const f = fixture();
  f.browser.close = async () => {
    throw new Error("secret-cookie in browser teardown");
  };
  await expect(setupSelfHostedLearning(f.options)).rejects.toThrow(
    "The temporary sign-in browser could not be closed.",
  );
});

test("API origins reject credentials, paths, and insecure non-loopback servers", () => {
  expect(intelligenceApiOrigin("https://intelligence.example/")).toBe(apiUrl);
  expect(intelligenceApiOrigin("http://127.0.0.1:4000")).toBe(
    "http://127.0.0.1:4000",
  );
  for (const value of [
    "http://customer.example",
    "https://user:password@example.com",
    "https://example.com/api",
    "https://example.com?token=secret",
    "file:///tmp/a",
  ]) {
    expect(() => intelligenceApiOrigin(value)).toThrow();
  }
});
