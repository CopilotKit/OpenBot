/**
 * Inside an OpenBot Desktop connected to an OpenBot that runs somewhere else, the desktop app signs
 * every request in, and a sign-in of that kind carries no memory of which organization the person
 * is working in. So the desktop app is told on every switch, after the server has agreed to it and
 * before the app changes over, and it names that organization on each request from then on.
 *
 * In a browser, and with OpenBot on this computer, nobody is told: the session remembers.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { signedInUser } from "@/lib/auth/queries";
import {
  currentOrganizationId,
  setCurrentOrganization,
} from "@/lib/organizations/current";
import { workIn } from "@/lib/organizations/queries";
import { queryClient } from "@/query-client";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://127.0.0.1:3010/" });
});
afterAll(() => {
  GlobalRegistrator.unregister();
});

/** What happened, in order: each request to the server and each command asked of the desktop app. */
let happened: string[] = [];
let serverAgrees = true;
const originalFetch = globalThis.fetch;

function installShell(answer: "accepts" | "refuses") {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: async (command: string, args?: Record<string, unknown>) => {
      happened.push(`shell ${command} ${JSON.stringify(args ?? {})}`);
      if (answer === "refuses") throw "command set_organization not found";
      return null;
    },
  };
}

beforeEach(() => {
  happened = [];
  serverAgrees = true;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      happened.push(`server ${new URL(url, "http://127.0.0.1:3010").pathname}`);
      return serverAgrees
        ? Response.json({ id: "org_harbor" })
        : Response.json({ error: "Not found" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

test("a switch is told to the desktop app once the server has agreed to it", async () => {
  installShell("accepts");
  await workIn("org_harbor");
  expect(happened).toEqual([
    "server /api/auth/organization/set-active",
    'shell plugin:openbot-desktop|set_organization {"organizationId":"org_harbor"}',
  ]);
});

test("a switch the server refuses is not told to the desktop app", async () => {
  installShell("accepts");
  serverAgrees = false;
  await expect(workIn("org_northwind")).rejects.toThrow();
  expect(happened).toEqual(["server /api/auth/organization/set-active"]);
});

test("a desktop app that has no such command does not stop the switch", async () => {
  installShell("refuses");
  await workIn("org_harbor");
  expect(happened).toHaveLength(2);
});

test("in a browser nobody else is told", async () => {
  await workIn("org_harbor");
  expect(happened).toEqual(["server /api/auth/organization/set-active"]);
});

/**
 * Signed in again after signing out while working in somebody else's organization, the desktop
 * app names that one on every request, as it should: the person goes on where they left off. When
 * they have since been removed from it, the server answers it as an organization that does not
 * exist. The app then asks the desktop app to name none, so the server works in the person's own,
 * reads the list again, and opens there. Never an error screen for it.
 */
describe("an organization the person has left, named by the desktop app", () => {
  const OWN = {
    id: "org_ana",
    slug: "ana",
    name: "Ana Lindqvist's organization",
  };
  const KAI = { id: "org_kai", slug: "kai", name: "Kai's organization" };
  /** What the desktop app names on each request, as its relay does. */
  let named: string | null;
  /** The organizations the person is in, by the server's records. */
  let memberOf: string[];

  function problem(status: number, code: string, detail: string): Response {
    return new Response(JSON.stringify({ status, code, detail, title: code }), {
      status,
      headers: { "content-type": "application/problem+json" },
    });
  }

  beforeEach(() => {
    queryClient.clear();
    setCurrentOrganization(undefined);
    named = KAI.id;
    memberOf = [OWN.id];
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      transformCallback: () => 0,
      invoke: async (command: string, args?: Record<string, unknown>) => {
        happened.push(`shell ${command} ${JSON.stringify(args ?? {})}`);
        if (command === "plugin:openbot-desktop|set_organization")
          named = (args?.organizationId as string | null) ?? null;
        return null;
      },
    };
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const path = new URL(String(input), "http://127.0.0.1:3010").pathname;
        happened.push(`server ${path}${named ? ` as ${named}` : ""}`);
        if (path === "/api/v2/organizations/default/deployment")
          return Response.json({
            generativeUi: true,
            selfHostBanner: false,
            localEvaluation: false,
            edition: "team",
          });
        if (path === "/api/v2/people/me/organizations") {
          // As the server answers an app's token whose header names one the person is not in.
          if (named && !memberOf.includes(named))
            return problem(
              404,
              "ORGANIZATION_NOT_FOUND",
              "Couldn't find that organization.",
            );
          const working = named ?? OWN.id;
          return Response.json({
            organizations: [OWN, KAI]
              .filter((one) => memberOf.includes(one.id))
              .map((one) => ({
                ...one,
                role: "owner",
                active: one.id === working,
              })),
            canCreate: true,
            nextCursor: null,
          });
        }
        if (path === `/api/v2/organizations/${OWN.id}/people/me`)
          return Response.json({
            person: {
              id: "ana",
              email: "ana@example.com",
              name: "Ana Lindqvist",
              needsName: false,
              image: null,
              role: "admin",
              onboarding: null,
            },
            openbotVersion: null,
          });
        return problem(404, "NOT_FOUND", "Not served.");
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterEach(() => {
    queryClient.clear();
    setCurrentOrganization(undefined);
  });

  test("the app falls back to the person's own organization, with no error", async () => {
    const person = await signedInUser(queryClient);
    expect(person?.name).toBe("Ana Lindqvist");
    expect(currentOrganizationId()).toBe(OWN.id);
    expect(named).toBeNull();
    expect(happened).toEqual([
      "server /api/v2/organizations/default/deployment as org_kai",
      "server /api/v2/people/me/organizations as org_kai",
      'shell plugin:openbot-desktop|set_organization {"organizationId":null}',
      "server /api/v2/people/me/organizations",
      `server /api/v2/organizations/${OWN.id}/people/me`,
    ]);
  });

  test("still a member, the person goes on in the organization they left off in", async () => {
    memberOf = [OWN.id, KAI.id];
    await signedInUser(queryClient).catch(() => null);
    expect(currentOrganizationId()).toBe(KAI.id);
    expect(named).toBe(KAI.id);
    expect(happened).not.toContain(
      'shell plugin:openbot-desktop|set_organization {"organizationId":null}',
    );
  });

  test("in a browser the refusal is said, as it always was", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    await expect(signedInUser(queryClient)).rejects.toThrow(
      "Couldn't find that organization.",
    );
    expect(currentOrganizationId()).toBeUndefined();
  });
});
