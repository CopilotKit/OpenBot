import { afterEach, describe, expect, test } from "bun:test";
import type {
  LearnedSkillContent,
  LearningOverview,
  LearningProposalDetail,
} from "@openbot/shared/learning";
import type { MiddlewareHandler } from "hono";
import type { AuditEventInput } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  createLearningAutoAssign,
  runtimeKeyClient,
  withLearningAutoAssign,
} from "../src/learning/auto-assign";
import { createInspectorLearningReader } from "../src/learning/inspector";
import {
  createLearningRoutes,
  learningModelUnavailable,
} from "../src/learning/routes";
import { createLearningSettingsStore } from "../src/learning/settings";
import {
  type FakeIntelligence,
  fakeIntelligence,
  INSPECTOR_WITH_DASHBOARD,
  RUNTIME_KEY,
  SKILL_MD,
} from "./support/intelligence-learning";

function routes(role: "admin" | "user" = "admin") {
  const store = createLearningSettingsStore();
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: "person", email: "person@example.com", role });
    await next();
  };
  return {
    store,
    app: createLearningRoutes(
      {
        store,
        inspect: async () => {
          throw new Error("secret-project-key");
        },
      },
      requireUser,
      ["https://openbot.example.com"],
    ),
  };
}

test("only administrators can read or write learning settings", async () => {
  const { app } = routes("user");
  expect((await app.request("/settings")).status).toBe(403);
  // Same-origin JSON, so the refusal is the admin guard and not the origin check.
  const sameOrigin = await app.request("https://openbot.example.com/settings", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin: "https://openbot.example.com",
    },
    body: JSON.stringify({ enabled: true, agents: {} }),
  });
  expect(sameOrigin.status).toBe(403);
  expect(await sameOrigin.json()).toEqual({
    error: "Only an admin can do this.",
  });
});

test("administrators see learning enabled before selecting a container", async () => {
  const { app } = routes();
  const response = await app.request("/settings");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    settings: { enabled: true, defaultTarget: null, agents: {} },
  });
});

test("rejects cross-origin and non-JSON writes before changing settings", async () => {
  const { app, store } = routes();
  const before = await store.read();
  for (const headers of [
    { "content-type": "application/json", origin: "https://evil.example" },
    { "content-type": "text/plain" },
  ]) {
    expect(
      (
        await app.request("https://openbot.example.com/settings", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            enabled: true,
            defaultTarget: { containerId: "support" },
            agents: {},
          }),
        })
      ).status,
    ).toBe(403);
  }
  expect(await store.read()).toEqual(before);
});

test("validates and persists a same-origin admin save", async () => {
  const { app } = routes();
  const settings = {
    enabled: true,
    defaultTarget: { containerId: "support" },
    agents: { excluded: null },
  };
  const response = await app.request("https://openbot.example.com/settings", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin: "https://openbot.example.com",
    },
    body: JSON.stringify(settings),
  });
  expect(response.status).toBe(200);
  expect(await (await app.request("/settings")).json()).toEqual({ settings });
  expect(
    (
      await app.request("/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: '{"enabled":true}',
      })
    ).status,
  ).toBe(400);
});

test("a settings save keeps who approves and automatic approval when it leaves them out", async () => {
  const { app, store } = routes();
  await store.write({
    enabled: true,
    defaultTarget: null,
    agents: {},
    personalReview: "people",
    autoApprove: false,
  });
  const response = await app.request("https://openbot.example.com/settings", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin: "https://openbot.example.com",
    },
    body: JSON.stringify({
      enabled: true,
      defaultTarget: { containerId: "support" },
      agents: {},
    }),
  });
  expect(response.status).toBe(200);
  expect(await store.read()).toMatchObject({
    defaultTarget: { containerId: "support" },
    personalReview: "people",
    autoApprove: false,
  });
});

test("an admin switches who approves, and a later settings save keeps it", async () => {
  const store = createLearningSettingsStore();
  const events: AuditEventInput[] = [];
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "admin-ada",
      email: "ada@example.com",
      role: "admin",
    });
    await next();
  };
  const app = createLearningRoutes(
    { store },
    requireUser,
    ["https://openbot.example.com"],
    { insert: async (event) => void events.push(event) },
  );
  const put = (
    path: string,
    body: unknown,
    origin = "https://openbot.example.com",
  ) =>
    app.request(`https://openbot.example.com${path}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify(body),
    });
  expect(
    (
      await put(
        "/personal-review",
        { personalReview: "people" },
        "https://evil.example",
      )
    ).status,
  ).toBe(403);
  expect(
    (await put("/personal-review", { personalReview: "nobody" })).status,
  ).toBe(400);
  const response = await put("/personal-review", { personalReview: "people" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    settings: { personalReview: "people" },
  });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    eventType: "configuration.changed",
    targetType: "learning",
    actorUserId: "admin-ada",
    payload: { change: "personal_review", from: "admins", to: "people" },
  });
  expect(
    (await put("/settings", { enabled: true, defaultTarget: null, agents: {} }))
      .status,
  ).toBe(200);
  expect((await store.read()).personalReview).toBe("people");
});

test("upstream errors never expose credentials", async () => {
  const { app } = routes();
  const response = await app.request("/overview");
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("secret-project-key");
});

test("the settings page assigns a newly created container on load and says why not otherwise", async () => {
  const store = createLearningSettingsStore();
  let probe: "absent" | "present" = "absent";
  const autoAssign = createLearningAutoAssign({
    enabled: true,
    store,
    probe: async () => probe,
    log: () => {},
    minIntervalMs: 0,
  });
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "person",
      email: "person@example.com",
      role: "admin",
    });
    await next();
  };
  const app = createLearningRoutes(
    { store: withLearningAutoAssign(store, autoAssign), autoAssign },
    requireUser,
  );
  expect(await (await app.request("/settings")).json()).toEqual({
    settings: { enabled: true, defaultTarget: null, agents: {} },
    automatic: {
      state: "absent",
      containerId: "openbot",
      canCreate: false,
      instructions: expect.stringContaining("bun scripts/setup-learning.ts"),
    },
  });
  probe = "present";
  expect(await (await app.request("/settings")).json()).toEqual({
    settings: {
      enabled: true,
      defaultTarget: { containerId: "openbot" },
      agents: {},
    },
    automatic: { state: "assigned", containerId: "openbot" },
  });
});

test("an administrator creates the container with the deployment's credential, same-origin only", async () => {
  const store = createLearningSettingsStore();
  let probe: "absent" | "present" = "absent";
  let creates = 0;
  const autoAssign = createLearningAutoAssign({
    enabled: true,
    store,
    probe: async () => probe,
    // As at boot: the first attempt finds nothing to create with yet.
    create: async () => {
      creates++;
      if (creates === 1) return "skipped";
      probe = "present";
      return "created";
    },
    log: () => {},
  });
  await autoAssign.check();
  const actor = (role: "admin" | "user") =>
    (async (context, next) => {
      context.set("actor", {
        id: "person",
        email: "person@example.com",
        role,
      });
      await next();
    }) as MiddlewareHandler<{ Variables: AppVariables }>;
  const post = (app: ReturnType<typeof createLearningRoutes>, origin: string) =>
    app.request("https://openbot.example.com/container", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: "{}",
    });
  const member = createLearningRoutes({ store, autoAssign }, actor("user"));
  expect((await post(member, "https://openbot.example.com")).status).toBe(403);
  const admin = createLearningRoutes({ store, autoAssign }, actor("admin"));
  expect((await post(admin, "https://evil.example")).status).toBe(403);
  expect(creates).toBe(1);
  const response = await post(admin, "https://openbot.example.com");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    automatic: { state: "assigned", containerId: "openbot" },
  });
  expect(creates).toBe(2);
  expect((await store.read()).defaultTarget).toEqual({
    containerId: "openbot",
  });
});

describe("reviewing proposed skills in Admin, against Intelligence's project-key routes", () => {
  const PROPOSAL = "0198a012-a20f-77c0-9e33-8992f18e74d1";
  const served: FakeIntelligence[] = [];
  afterEach(() => {
    for (const intelligence of served.splice(0)) intelligence.stop();
  });
  function admin(
    version: Parameters<typeof fakeIntelligence>[0] = "current",
    role: "admin" | "user" = "admin",
    inspector?: "no-dashboard" | "dashboard" | "dashboard-before-opt-in",
    model: { noModel?: boolean; modelUnavailable?: "unsupported" } = {},
  ) {
    const intelligence = fakeIntelligence(version, {
      containers: ["openbot"],
      candidates: [PROPOSAL],
      ...(inspector ? { inspector } : {}),
      ...(model.noModel ? { noModel: true } : {}),
    });
    served.push(intelligence);
    const client = runtimeKeyClient(
      intelligence.url,
      RUNTIME_KEY,
      "ws://127.0.0.1:9",
    );
    const store = createLearningSettingsStore();
    const events: AuditEventInput[] = [];
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: "admin-ada",
        email: "ada@example.com",
        name: "Ada",
        role,
      });
      await next();
    };
    const app = createLearningRoutes(
      {
        store,
        inspect: createInspectorLearningReader({
          apiUrl: intelligence.url,
          apiKey: RUNTIME_KEY,
        }),
        manage: client.experimental.learning,
        ...(model.modelUnavailable
          ? { modelUnavailable: model.modelUnavailable }
          : {}),
      },
      requireUser,
      ["https://openbot.example.com"],
      { insert: async (event) => void events.push(event) },
    );
    return { app, store, events, intelligence };
  }
  const post = (app: ReturnType<typeof createLearningRoutes>, path: string) =>
    app.request(`https://openbot.example.com${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://openbot.example.com",
      },
      body: "{}",
    });
  const useDefault = async (
    store: ReturnType<typeof createLearningSettingsStore>,
  ) =>
    store.write({
      enabled: true,
      defaultTarget: { containerId: "openbot" },
      agents: {},
    });

  test("an admin lists the container's analysis runs", async () => {
    const { app, store } = admin();
    await useDefault(store);
    const response = await app.request("/runs");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      containerId: string;
      runs: unknown[];
    };
    expect(body.containerId).toBe("openbot");
    expect(body.runs[0]).toMatchObject({
      status: "succeeded",
      trigger: expect.any(String),
    });
    expect((await admin("current", "user").app.request("/runs")).status).toBe(
      403,
    );
  });

  test("published skills say it is automatic learning that is off", async () => {
    const store = createLearningSettingsStore();
    await useDefault(store);
    const app = createLearningRoutes(
      { store, skills: async () => ({ unavailable: "off" }) },
      async (context, next) => {
        context.set("actor", {
          id: "admin-ada",
          email: "ada@example.com",
          name: "Ada",
          role: "admin",
        });
        await next();
      },
    );
    const response = await app.request("/skills");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        "Automatic learning is turned off. Turn it on to see published skills.",
    });
  });

  test("an admin reads a published skill's files", async () => {
    const store = createLearningSettingsStore();
    await useDefault(store);
    const skill: LearnedSkillContent = {
      name: "weekly-report",
      description: "Write the weekly report.",
      files: [{ path: "SKILL.md", text: "# Weekly report" }],
    };
    const build = (role: "admin" | "user") =>
      createLearningRoutes(
        {
          store,
          skills: async (containerId) =>
            containerId === "openbot" ? { skills: [skill] } : { skills: [] },
        },
        async (context, next) => {
          context.set("actor", {
            id: "admin-ada",
            email: "ada@example.com",
            name: "Ada",
            role,
          });
          await next();
        },
      );
    const app = build("admin");
    const list = await app.request("/skills");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      containerId: "openbot",
      skills: [
        { name: "weekly-report", description: "Write the weekly report." },
      ],
    });
    const found = await app.request("/skills/weekly-report");
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ skill });
    expect((await app.request("/skills/unknown")).status).toBe(404);
    expect((await app.request("/skills/a%2Fb")).status).toBe(400);
    expect((await build("user").request("/skills/weekly-report")).status).toBe(
      403,
    );
  });

  test("only an admin may list, read, approve, reject or start Learning", async () => {
    const { app, intelligence } = admin("current", "user");
    for (const response of [
      await app.request("/proposals"),
      await app.request(`/proposals/${PROPOSAL}`),
      await post(app, `/proposals/${PROPOSAL}/approve`),
      await post(app, `/proposals/${PROPOSAL}/reject`),
      await post(app, "/runs"),
    ])
      expect(response.status).toBe(403);
    expect(intelligence.requests).toEqual([]);
  });

  test("an admin reads the SKILL.md and evidence, approves it, and OpenBot's audit names them", async () => {
    const { app, store, events, intelligence } = admin();
    await useDefault(store);
    expect(await (await app.request("/proposals")).json()).toMatchObject({
      containerId: "openbot",
      proposals: [
        { id: PROPOSAL, title: "Refund triage", status: "pending_review" },
      ],
    });
    const detail = (await (
      await app.request(`/proposals/${PROPOSAL}`)
    ).json()) as { proposal: LearningProposalDetail };
    expect(detail.proposal.files[0]).toEqual({
      path: "SKILL.md",
      content: SKILL_MD,
    });
    expect(detail.proposal.insights[0]?.evidence).toEqual([
      {
        kind: "conversation",
        id: "thread-1",
        title: "Refund for order 1182",
        available: true,
        messages: [
          {
            id: "message-1",
            role: "user",
            content: "Can I get a refund on order 1182?",
          },
          {
            id: "message-2",
            role: "assistant",
            content: "That order is 12 days old, so yes.",
          },
        ],
      },
      {
        kind: "recording",
        id: "0198a012-a20f-77c0-9e33-8992f18e74b0",
        title: null,
        available: true,
        eventCount: 1,
        events: ["click"],
      },
    ]);

    const approved = await post(app, `/proposals/${PROPOSAL}/approve`);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({
      proposal: { id: PROPOSAL, status: "approved" },
    });
    expect(intelligence.candidates.get(PROPOSAL)?.status).toBe("approved");
    expect(events).toEqual([
      {
        eventType: "configuration.changed",
        targetType: "learning_skill",
        targetId: PROPOSAL,
        actorUserId: "admin-ada",
        payload: {
          change: "skill_approved",
          containerId: "openbot",
          title: "Refund triage",
          operation: "add",
          publishedSkillId: "0198a012-a20f-77c0-9e33-8992f18e74a2",
          by: "ada@example.com",
        },
      },
    ]);

    // Reviewed once is reviewed: a second decision is refused, said plainly, and audited.
    const again = await post(app, `/proposals/${PROPOSAL}/reject`);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain(
      "already reviewed",
    );
    expect(events[1]?.payload).toMatchObject({
      change: "skill_review_failed",
      decision: "reject",
      code: "LEARNING_CANDIDATE_CONFLICT",
      by: "ada@example.com",
    });
  });

  test("a cross-site approval is refused before Intelligence is asked", async () => {
    const { app, store, intelligence } = admin();
    await useDefault(store);
    const response = await app.request(
      `https://openbot.example.com/proposals/${PROPOSAL}/approve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: "{}",
      },
    );
    expect(response.status).toBe(403);
    expect(intelligence.requests).toEqual([]);
  });

  test("Learn now starts a run on the container and is audited", async () => {
    const { app, store, events } = admin();
    await useDefault(store);
    const response = await post(app, "/runs");
    expect(await response.json()).toEqual({
      run: { id: "0198a012-a20f-77c0-9e33-8992f18e74c1", status: "queued" },
    });
    expect(events[0]).toMatchObject({
      actorUserId: "admin-ada",
      payload: { change: "learning_run_started", containerId: "openbot" },
    });
  });

  test("on a sign-in Learning can't use, Learn now and the overview say why and what to do", async () => {
    const { app, store } = admin("current", "admin", "no-dashboard", {
      noModel: true,
      modelUnavailable: learningModelUnavailable({
        OPENBOT_LEARNING_MODEL_UNAVAILABLE: "unsupported",
      }),
    });
    await useDefault(store);
    const said =
      "Learning can't run on the model you signed in with. To use it, sign OpenBot in with an OpenAI or Anthropic API key, or a Claude or ChatGPT plan.";
    const response = await post(app, "/runs");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: said });
    const overview = (await (await app.request("/overview")).json()) as {
      overview: LearningOverview;
    };
    expect(overview.overview.modelProblem).toBe(said);
  });

  test("an Intelligence OpenBot Desktop did not set up keeps telling its admin to give it a model", async () => {
    const { app, store } = admin("current", "admin", "no-dashboard", {
      noModel: true,
      modelUnavailable: learningModelUnavailable({}),
    });
    await useDefault(store);
    const response = await post(app, "/runs");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "The backend has no Learning model yet. Give its Learning agent a model and key, then try again.",
    });
    const overview = (await (await app.request("/overview")).json()) as {
      overview: LearningOverview;
    };
    expect(overview.overview.modelProblem).toBeUndefined();
  });

  test("with no dashboard, the overview has the Inspector panel's counts and links nowhere", async () => {
    const { app, store } = admin("current", "admin", "no-dashboard");
    await useDefault(store);
    const response = await app.request("/overview");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      overview: {
        configuration: "configured",
        container: { id: "openbot", name: "OpenBot" },
        pendingThreadCount: 1,
        pendingCandidateCount: 1,
        publishedSkillCount: 1,
        insightCount: 1,
        hasActiveRun: false,
        latestRunStatus: "succeeded",
        links: { learning: null, candidates: null, runs: null },
      },
    });
  });

  test("with a dashboard, the overview has the same counts and links into it, on any Intelligence", async () => {
    for (const inspector of ["dashboard", "dashboard-before-opt-in"] as const) {
      const { app, store, intelligence } = admin("current", "admin", inspector);
      await useDefault(store);
      const response = await app.request("/overview");
      expect(response.status).toBe(200);
      expect(
        ((await response.json()) as { overview: LearningOverview }).overview,
      ).toMatchObject({
        pendingThreadCount: 1,
        publishedSkillCount: 1,
        insightCount: 1,
        links: INSPECTOR_WITH_DASHBOARD.links,
      });
      // An older Intelligence refuses the opt-in it does not know; the plain call answers.
      expect(
        intelligence.requests.filter(
          (request) => request.path === "/api/inspector/learning",
        ).length,
      ).toBe(inspector === "dashboard" ? 1 : 2);
    }
  });

  test("an Intelligence with no Inspector panel gives the overview from the key's own routes", async () => {
    const { app, store } = admin();
    await useDefault(store);
    const response = await app.request("/overview");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      overview: {
        configuration: "configured",
        container: { id: "openbot", name: "openbot" },
        pendingThreadCount: null,
        pendingCandidateCount: 1,
        publishedSkillCount: null,
        insightCount: null,
        hasActiveRun: false,
        latestRunStatus: "succeeded",
        links: { learning: null, candidates: null, runs: null },
      },
    });
  });

  test("Learning switched off in Intelligence is said as that, on the list and the overview", async () => {
    const { app, store } = admin("learning-off");
    await useDefault(store);
    for (const path of ["/proposals", "/overview"]) {
      const response = await app.request(path);
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toContain(
        "Learning is switched off in the backend",
      );
    }
  });
});
