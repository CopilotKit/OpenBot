import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { capabilityRefusal } from "../src/admin/capabilities";
import {
  type EnterpriseControls,
  installEnterpriseControls,
} from "../src/admin/controls";
import { createEnterpriseAdminRoutes } from "../src/admin/routes";
import { runsIsolated } from "../src/agents/isolation";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAgentRoutes } from "../src/agents/routes";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { personBrowserId } from "../src/browser/person";
import {
  botOwnership,
  createComputerSeatResolver,
  seatOf,
} from "../src/computer/computer-key";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  capabilitySettings,
  deploymentPackages,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Isolated Bots, through the routes a person and an administrator use, against a real PostgreSQL.
 *
 * The promises: a Bot gets a computer of its own only for somebody holding "Isolated Bots"; asking
 * without it is refused with the gate's own sentence and leaves a row on the trail; turning it off is
 * never refused; a Bot's page knows whether its computer of its own is in effect, from its OWNER's
 * switch as it is now; a copy keeps it only for a duplicator who may have it; and a Bot that belongs
 * to no person never gets one.
 *
 * The switch is flipped through the admin route and read by the real enterprise controls, because a
 * fake that answered "allowed" would pass while the real resolution (baseline, role, group) did not.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const store = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const suite = randomUUID().slice(0, 8);
const group = `isolators-${suite}`;
const admin = {
  id: `iso-admin-${suite}`,
  email: `iso-admin-${suite}@acme.test`,
  role: "admin" as const,
};
const owner = {
  id: `iso-owner-${suite}`,
  email: `iso-owner-${suite}@acme.test`,
  role: "user" as const,
};
const colleague = {
  id: `iso-colleague-${suite}`,
  email: `iso-colleague-${suite}@acme.test`,
  role: "user" as const,
};
let controls: EnterpriseControls;
let packageId: string | undefined;

async function cleanSwitch() {
  await database
    .delete(capabilitySettings)
    .where(eq(capabilitySettings.capability, "isolatedComputers"));
}

beforeAll(async () => {
  await cleanSwitch();
  await database.insert(users).values([
    { id: admin.id, email: admin.email, name: "Admin" },
    { id: owner.id, email: owner.email, name: "Owner", groups: [group] },
    { id: colleague.id, email: colleague.email, name: "Colleague" },
  ]);
  controls = await installEnterpriseControls({
    database,
    databaseUrl: testDatabaseUrl(),
    auditStore,
    env: {},
  });
});

afterAll(async () => {
  await controls?.stop();
  await cleanSwitch();
  const made = await database
    .select({ id: agentProfiles.agentId })
    .from(agentProfiles)
    .where(
      inArray(agentProfiles.ownerUserId, [admin.id, owner.id, colleague.id]),
    );
  if (made.length) {
    await database.delete(agents).where(
      inArray(
        agents.id,
        made.map((row) => row.id),
      ),
    );
  }
  await database.delete(agents).where(like(agents.id, `iso-pkg-${suite}%`));
  if (packageId) {
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.id, packageId));
  }
  // Audit rows are append-only and stay, as every other suite's do.
  await database.delete(users).where(like(users.email, `%${suite}%`));
  await database.$client.end({ timeout: 5 });
});

type Actor = typeof admin | typeof owner | typeof colleague;

function appFor(actor: Actor, available = true) {
  const app = new Hono<{ Variables: AppVariables }>();
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  app.route(
    "/api/agents",
    createAgentRoutes(
      store,
      requireUser,
      false,
      auditStore,
      new Set(),
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      { available },
    ),
  );
  app.route("/api/admin/enterprise", createEnterpriseAdminRoutes(requireUser));
  return app;
}

const call = (
  actor: Actor,
  method: string,
  path: string,
  body?: unknown,
  available = true,
) =>
  appFor(actor, available).request(`http://openbot.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** The switch for everybody, as the admin Enterprise screen sets it. Null removes the row. */
async function setSwitch(allowed: boolean | null) {
  const response = await call(
    admin,
    "PUT",
    "/api/admin/enterprise/capabilities",
    { scopeKind: "organization", capability: "isolatedComputers", allowed },
  );
  expect(response.status).toBe(200);
}

function bot(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    title: "Researcher",
    roleDescription: "Looks things up.",
    visibility: "private",
    ...extra,
  };
}

async function createBot(
  actor: Actor,
  name: string,
  extra: Record<string, unknown> = {},
) {
  const response = await call(actor, "POST", "/api/agents", bot(name, extra));
  expect(response.status).toBe(201);
  return (await response.json()).agent as Record<string, unknown> & {
    id: string;
  };
}

async function storedIsolated(agentId: string) {
  const [row] = await database
    .select({ isolated: agentProfiles.isolated })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agentId));
  return row?.isolated;
}

async function refusals(actorId: string) {
  return database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "bot.isolation_refused"),
        eq(auditEvents.actorUserId, actorId),
      ),
    );
}

describe("making an isolated Bot", () => {
  test("somebody holding the switch gets one, and the trail names it", async () => {
    const agent = await createBot(owner, `Isolated ${suite}`, {
      isolated: true,
    });

    expect(agent).toMatchObject({
      isolated: true,
      isolationActive: true,
      isolationOffReason: null,
    });
    expect(await storedIsolated(agent.id)).toBe(true);
    const [created] = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "bot.created"),
          eq(auditEvents.targetId, agent.id),
        ),
      );
    expect(created?.payload).toMatchObject({ isolated: true });
  });

  test("without the switch it is refused, nothing is made, and the refusal is on the trail", async () => {
    await setSwitch(false);
    try {
      const name = `Refused ${suite}`;
      const response = await call(
        owner,
        "POST",
        "/api/agents",
        bot(name, { isolated: true }),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: capabilityRefusal("isolatedComputers"),
        capability: "isolatedComputers",
      });
      expect(
        await database.select().from(agents).where(eq(agents.name, name)),
      ).toEqual([]);
      const [row] = await refusals(owner.id);
      expect(row?.targetId).toBeNull();
      expect(row?.payload).toMatchObject({
        reason: "capability",
        name,
        attempted: "create",
      });

      // A Bot that shares its owner's computer needs no switch.
      const shared = await createBot(owner, `Shared ${suite}`);
      expect(shared.isolated).toBe(false);
    } finally {
      await setSwitch(null);
    }
  });

  test("a string is not a yes", async () => {
    const response = await call(
      owner,
      "POST",
      "/api/agents",
      bot(`Stringly ${suite}`, { isolated: "true" }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      "Isolated must be true or false.",
    );
  });
});

describe("changing it later", () => {
  test("turning it on needs the switch; turning it off never does", async () => {
    const agent = await createBot(owner, `Later ${suite}`);
    await setSwitch(false);
    try {
      const refused = await call(
        owner,
        "PATCH",
        `/api/agents/${agent.id}`,
        bot(`Later ${suite}`, { isolated: true }),
      );
      expect(refused.status).toBe(403);
      expect((await refused.json()).capability).toBe("isolatedComputers");
      expect(await storedIsolated(agent.id)).toBe(false);
      const rows = await refusals(owner.id);
      expect(
        rows.find((row) => row.targetId === agent.id)?.payload,
      ).toMatchObject({ reason: "capability", bot: agent.id });
    } finally {
      await setSwitch(null);
    }

    const turnedOn = await call(
      owner,
      "PATCH",
      `/api/agents/${agent.id}`,
      bot(`Later ${suite}`, { isolated: true }),
    );
    expect(turnedOn.status).toBe(200);
    expect(await storedIsolated(agent.id)).toBe(true);

    await setSwitch(false);
    try {
      // An edit that does not mention it leaves it alone, switch or no switch.
      const renamed = await call(
        owner,
        "PATCH",
        `/api/agents/${agent.id}`,
        bot(`Renamed ${suite}`),
      );
      expect(renamed.status).toBe(200);
      expect((await renamed.json()).agent).toMatchObject({
        name: `Renamed ${suite}`,
        isolated: true,
      });

      const turnedOff = await call(
        owner,
        "PATCH",
        `/api/agents/${agent.id}`,
        bot(`Renamed ${suite}`, { isolated: false }),
      );
      expect(turnedOff.status).toBe(200);
      expect(await storedIsolated(agent.id)).toBe(false);
    } finally {
      await setSwitch(null);
    }
  });

  test("an administrator ticking Isolated on somebody's Bot is asked about the owner's switch, not their own", async () => {
    const agent = await createBot(owner, `Owners ${suite}`);
    // Off for everybody, and given back to a group only the administrator is in: the editor holds the switch, the
    // owner does not, which is the case that used to save a tick the Bot never ran with.
    const admins = `${group}-admins`;
    const forAdmins = async (allowed: boolean | null) =>
      expect(
        (
          await call(admin, "PUT", "/api/admin/enterprise/capabilities", {
            scopeKind: "group",
            scopeId: admins,
            capability: "isolatedComputers",
            allowed,
          })
        ).status,
      ).toBe(200);
    await database
      .update(users)
      .set({ groups: [admins] })
      .where(eq(users.id, admin.id));
    await setSwitch(false);
    await forAdmins(true);
    try {
      const refused = await call(
        admin,
        "PATCH",
        `/api/agents/${agent.id}`,
        bot(`Owners ${suite}`, { isolated: true }),
      );
      expect(refused.status).toBe(403);
      const body = await refused.json();
      expect(body.capability).toBe("isolatedComputers");
      expect(body.error).toContain("this Bot's owner");
      // Never saved, so it never sits ticked while running on the owner's computer.
      expect(await storedIsolated(agent.id)).toBe(false);
    } finally {
      await forAdmins(null);
      await setSwitch(null);
      await database
        .update(users)
        .set({ groups: [] })
        .where(eq(users.id, admin.id));
    }
    // With the owner's switch on, the administrator may tick it for them.
    const ticked = await call(
      admin,
      "PATCH",
      `/api/agents/${agent.id}`,
      bot(`Owners ${suite}`, { isolated: true }),
    );
    expect(ticked.status).toBe(200);
    expect(await storedIsolated(agent.id)).toBe(true);
  });

  test("a Bot that belongs to no person is refused one, and the trail says why", async () => {
    const [deploymentPackage] = await database
      .insert(deploymentPackages)
      .values({
        tenantId: `iso-tenant-${suite}`,
        sourcePath: "test/isolated-bots",
        checksum: randomUUID(),
      })
      .returning();
    packageId = deploymentPackage?.id;
    const agentId = `iso-pkg-${suite}`;
    await database.insert(agents).values({
      id: agentId,
      name: "General Assistant",
      type: "built_in",
      configuration: { systemPrompt: "Help." },
      packageId,
    });
    await database.insert(agentProfiles).values({
      agentId,
      ownerUserId: null,
      title: "Assistant",
      roleDescription: "Helps.",
      avatarSeed: agentId,
      visibility: "public",
    });

    const response = await call(
      admin,
      "PATCH",
      `/api/agents/${agentId}`,
      bot("General Assistant", { isolated: true, visibility: "public" }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(
      "This Bot doesn't belong to a person, so it can't have a computer of its own.",
    );
    expect(await storedIsolated(agentId)).toBe(false);
    const [row] = (await refusals(admin.id)).filter(
      (candidate) => candidate.targetId === agentId,
    );
    expect(row?.payload).toMatchObject({ reason: "unowned" });
  });
});

describe("whether it is in effect", () => {
  test("follows the owner's switch as it is now, for everybody who looks", async () => {
    const agent = await createBot(owner, `Effect ${suite}`, {
      isolated: true,
      visibility: "public",
    });
    expect(await runsIsolated(database, agent.id)).toBe(true);

    await setSwitch(false);
    try {
      for (const viewer of [owner, colleague]) {
        const read = await call(viewer, "GET", `/api/agents/${agent.id}`);
        expect((await read.json()).agent).toMatchObject({
          isolated: true,
          isolationActive: false,
          isolationOffReason: "admin",
        });
      }
      const listed = await call(owner, "GET", "/api/agents");
      expect(
        ((await listed.json()).agents as { id: string }[]).find(
          (entry) => entry.id === agent.id,
        ),
      ).toMatchObject({ isolationActive: false, isolationOffReason: "admin" });
      // The computer key reads the same verdict.
      expect(await runsIsolated(database, agent.id)).toBe(false);

      // A group the owner is in can be given it back while everybody else stays off.
      const granted = await call(
        admin,
        "PUT",
        "/api/admin/enterprise/capabilities",
        {
          scopeKind: "group",
          scopeId: group,
          capability: "isolatedComputers",
          allowed: true,
        },
      );
      expect(granted.status).toBe(200);
      const regranted = await call(colleague, "GET", `/api/agents/${agent.id}`);
      expect((await regranted.json()).agent).toMatchObject({
        isolationActive: true,
        isolationOffReason: null,
      });
      expect(await runsIsolated(database, agent.id)).toBe(true);
    } finally {
      await setSwitch(null);
      await database
        .delete(capabilitySettings)
        .where(
          and(
            eq(capabilitySettings.scopeKind, "group"),
            eq(capabilitySettings.scopeId, group),
          ),
        );
    }
  });

  /*
   * The computer key, read from the same verdict. An isolated Bot is one computer everybody who uses
   * it shares; withdrawing the switch puts it on each person's own computer from its next run, and
   * nobody has to edit the Bot.
   */
  test("the computer it runs on follows the verdict, and falls back to each person's when revoked", async () => {
    const agent = await createBot(owner, `Seat ${suite}`, {
      isolated: true,
      visibility: "public",
    });
    const seats = createComputerSeatResolver({
      runsIsolated: (botId) => runsIsolated(database, botId),
      bot: botOwnership(database),
      canIsolate: true,
    });
    const own = {
      botId: agent.id,
      key: { kind: "bot" as const, botId: agent.id },
    };
    expect(await seats.seatFor(agent.id, owner.id)).toEqual(own);
    expect(await seats.seatFor(agent.id, colleague.id)).toEqual(own);

    await setSwitch(false);
    try {
      expect(await seats.seatFor(agent.id, owner.id)).toEqual({
        botId: agent.id,
        key: { kind: "person", personId: owner.id },
      });
      expect(await seats.seatFor(agent.id, colleague.id)).toEqual({
        botId: agent.id,
        key: { kind: "person", personId: colleague.id },
      });
      // A provider that cannot make a computer for one Bot never hands one out, whatever the flag.
      await setSwitch(null);
      const shared = createComputerSeatResolver({
        runsIsolated: (botId) => runsIsolated(database, botId),
        bot: botOwnership(database),
        canIsolate: false,
      });
      expect((await shared.seatFor(agent.id, colleague.id)).key).toEqual({
        kind: "person",
        personId: colleague.id,
      });
    } finally {
      await setSwitch(null);
    }
  });

  test("a person's own browser is a computer of its own, never a seat on their computer beside their Bots", async () => {
    // Asked of nothing: a person's browser is not a Bot, has no Isolated flag and no owner row.
    const unasked = () => Promise.reject(new Error("Not asked for a person."));
    const browser = personBrowserId(owner.id);
    for (const canIsolate of [true, false]) {
      const seats = createComputerSeatResolver({
        runsIsolated: unasked,
        bot: unasked,
        canIsolate,
      });
      expect(await seats.seatFor(browser, owner.id)).toEqual({
        botId: browser,
        key: { kind: "bot", botId: browser },
      });
    }
    expect(seatOf(browser, owner.id, null, false).key).toEqual({
      kind: "bot",
      botId: browser,
    });
  });

  test("a deployment that cannot make a second computer says so, and refuses to promise one", async () => {
    const agent = await createBot(owner, `Nowhere ${suite}`, {
      isolated: true,
    });

    const capabilities = await call(
      owner,
      "GET",
      "/api/agents/capabilities",
      undefined,
      false,
    );
    expect((await capabilities.json()).capabilities).toMatchObject({
      isolationAvailable: false,
    });
    const read = await call(
      owner,
      "GET",
      `/api/agents/${agent.id}`,
      undefined,
      false,
    );
    expect((await read.json()).agent).toMatchObject({
      isolated: true,
      isolationActive: false,
      isolationOffReason: "deployment",
    });

    const refused = await call(
      owner,
      "POST",
      "/api/agents",
      bot(`Nowhere else ${suite}`, { isolated: true }),
      false,
    );
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe(
      "This OpenBot can't give a Bot a computer of its own, so it runs on yours.",
    );
    // Turning it off is still allowed here.
    const off = await call(
      owner,
      "PATCH",
      `/api/agents/${agent.id}`,
      bot(`Nowhere ${suite}`, { isolated: false }),
      false,
    );
    expect(off.status).toBe(200);
    expect(await storedIsolated(agent.id)).toBe(false);
  });
});

describe("duplicating", () => {
  test("a copy keeps its own computer only for somebody who may give it one", async () => {
    const source = await createBot(owner, `Original ${suite}`, {
      isolated: true,
      visibility: "public",
    });

    const kept = await call(
      colleague,
      "POST",
      `/api/agents/${source.id}/duplicate`,
    );
    expect(kept.status).toBe(201);
    const keptCopy = (await kept.json()).agent;
    expect(keptCopy).toMatchObject({ isolated: true, isolationActive: true });

    await setSwitch(false);
    try {
      const dropped = await call(
        colleague,
        "POST",
        `/api/agents/${source.id}/duplicate`,
      );
      expect(dropped.status).toBe(201);
      const droppedCopy = (await dropped.json()).agent;
      expect(droppedCopy).toMatchObject({
        isolated: false,
        isolationActive: false,
        isolationOffReason: null,
      });
      expect(await storedIsolated(droppedCopy.id)).toBe(false);
      // The original is untouched by somebody else copying it.
      expect(await storedIsolated(source.id)).toBe(true);
    } finally {
      await setSwitch(null);
    }
  });
});

afterAll(async () => {
  await database.$client.close();
});
