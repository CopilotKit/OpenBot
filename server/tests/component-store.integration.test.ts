import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  ComponentNotFoundError,
  type ComponentStore,
  createComponentStore,
} from "../src/components/store";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  componentExclusions,
  componentFunctions,
  components,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The grant surface, against a real database.
 *
 * Not mocked: every interesting property here is a property of the query. A left join that has to
 * return a row for a component nobody configured, a foreign key that has to take a Bot's
 * withholdings with it, a primary key that has to make withholding twice a no-op.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store: ComponentStore = createComponentStore(database);

const suite = randomUUID().slice(0, 8);
const componentName = `testComponent_${suite}`;
const otherName = `testOther_${suite}`;
const botA = `agent_test_a_${suite}`;
const botB = `agent_test_b_${suite}`;
const fixtureComponentNames = new Set<string>();
const fixtureAgentIds = new Set([botA, botB]);

async function makeComponent(name: string, published: boolean) {
  fixtureComponentNames.add(name);
  await database.insert(components).values({
    name,
    title: `Test ${name}`,
    kind: "chart",
    draftDescription: "The draft wording.",
    publishedDescription: published ? "The published wording." : null,
    published,
    ...(published ? { publishedAt: new Date() } : {}),
  });
}

beforeAll(async () => {
  for (const id of [botA, botB]) {
    await database
      .insert(agents)
      .values({ id, name: id, type: "remote_ag_ui", configuration: {} })
      .onConflictDoNothing();
  }
  await makeComponent(componentName, true);
  await makeComponent(otherName, false);
});

describe("component data functions against PostgreSQL", () => {
  // One connection keeps this temporary table visible to every query. Copy the migrated table
  // shape so the production SQL runs unchanged, without depending on other suites' audit rows.
  const reportsDatabase = createDatabase(testDatabaseUrl(), { max: 1 });
  const reports = createComponentStore(reportsDatabase);
  const day = 86_400_000;

  beforeAll(async () => {
    await reportsDatabase.execute(
      sql`create temporary table audit_events (like public.audit_events including all)`,
    );
  });

  beforeEach(async () => {
    await reportsDatabase.execute(sql`truncate table pg_temp.audit_events`);
  });

  afterAll(async () => {
    await reportsDatabase.$client.close();
  });

  function event(overrides: Partial<typeof auditEvents.$inferInsert>) {
    return {
      eventType: "component.rendered",
      targetType: "component",
      payload: { bot: "active-bot" },
      createdAt: new Date(Date.now() - day),
      ...overrides,
    };
  }

  test("bot activity aggregates recent actions and excludes older and unattributed rows", async () => {
    await reportsDatabase
      .insert(auditEvents)
      .values([
        event({}),
        event({}),
        event({ payload: { bot: "other-bot" } }),
        event({ createdAt: new Date(Date.now() - 8 * day) }),
        event({ payload: {} }),
      ]);

    expect(await reports.callFunction("botActivity", {})).toEqual({
      days: 7,
      rows: [
        { bot: "active-bot", actions: 2 },
        { bot: "other-bot", actions: 1 },
      ],
    });
  });

  test("bot activity caps the window at 90 days and returns only the 12 busiest bots", async () => {
    const ranked = Array.from({ length: 13 }, (_, index) => ({
      bot: `ranked-bot-${index}`,
      actions: 13 - index,
    }));
    await reportsDatabase.insert(auditEvents).values([
      ...ranked.flatMap(({ bot, actions }) =>
        Array.from({ length: actions }, () =>
          event({
            payload: { bot },
            createdAt: new Date(Date.now() - 30 * day),
          }),
        ),
      ),
      // If the time bound is ignored, this changes the highest-ranked bot's count.
      event({
        payload: { bot: "ranked-bot-0" },
        createdAt: new Date(Date.now() - 91 * day),
      }),
    ]);

    expect(
      await reports.callFunction("botActivity", { days: 100_000 }),
    ).toEqual({
      days: 90,
      rows: ranked.slice(0, 12),
    });
  });

  test("recent refusals filters event types, orders newest first and reads both reason formats", async () => {
    const now = Date.now();
    const fixtures = [
      {
        eventType: "computer.action_refused",
        payload: { bot: "computer-bot", reason: "Permission denied" },
      },
      {
        eventType: "component.refused",
        payload: {
          bot: "component-bot",
          decision: { rule: "Component withheld" },
        },
      },
      {
        eventType: "component.function_refused",
        payload: {
          bot: "function-bot",
          reason: "Explicit reason",
          decision: { rule: "Fallback reason" },
        },
      },
      { eventType: "bot.declined", payload: {} },
    ];
    await reportsDatabase
      .insert(auditEvents)
      .values([
        ...fixtures.map((fixture, index) =>
          event({ ...fixture, createdAt: new Date(now - (index + 1) * 1000) }),
        ),
        event({ eventType: "component.rendered", createdAt: new Date(now) }),
      ]);

    expect(await reports.callFunction("recentRefusals", {})).toEqual({
      rows: [
        expect.objectContaining({
          bot: "computer-bot",
          what: "computer.action_refused",
          reason: "Permission denied",
        }),
        expect.objectContaining({
          bot: "component-bot",
          what: "component.refused",
          reason: "Component withheld",
        }),
        expect.objectContaining({
          bot: "function-bot",
          what: "component.function_refused",
          reason: "Explicit reason",
        }),
        expect.objectContaining({
          bot: null,
          what: "bot.declined",
          reason: null,
        }),
      ],
    });
  });

  test("recent refusals defaults to 10 and clamps the requested limit to 1 through 50", async () => {
    const now = Date.now();
    const fixtures = Array.from({ length: 51 }, (_, index) =>
      event({
        eventType: "bot.declined",
        payload: { bot: `refusal-bot-${index}`, reason: `Reason ${index}` },
        createdAt: new Date(now - index * 1000),
      }),
    );
    await reportsDatabase.insert(auditEvents).values(fixtures);
    for (const { args, count } of [
      { args: {}, count: 10 },
      { args: { limit: 100_000 }, count: 50 },
      { args: { limit: 0 }, count: 1 },
    ]) {
      expect(await reports.callFunction("recentRefusals", args)).toEqual({
        rows: fixtures.slice(0, count).map((_, index) =>
          expect.objectContaining({
            bot: `refusal-bot-${index}`,
            what: "bot.declined",
            reason: `Reason ${index}`,
          }),
        ),
      });
    }
  });
});

afterAll(async () => {
  // Register before writes so a failed assertion or partially completed setup still has teardown.
  const names = [...fixtureComponentNames];
  await database
    .delete(componentFunctions)
    .where(inArray(componentFunctions.componentName, names));
  await database
    .delete(componentExclusions)
    .where(inArray(componentExclusions.componentName, names));
  await database.delete(components).where(inArray(components.name, names));
  await database.delete(agents).where(inArray(agents.id, [...fixtureAgentIds]));
});

describe("deciding whether a Bot may use a component", () => {
  test("a published component nobody configured is allowed", async () => {
    const decision = await store.decide(componentName, botA);

    expect(decision.allowed).toBeTrue();
    if (decision.allowed) {
      // The published wording, never the draft: a draft must not reach anything a model reads.
      expect(decision.description).toBe("The published wording.");
    }
  });

  test("a withheld component is refused, and says so", async () => {
    await store.revoke(componentName, botA, "someone@example.test");

    const decision = await store.decide(componentName, botA);
    expect(decision.allowed).toBeFalse();
    if (!decision.allowed) {
      expect(decision.reason).toContain("withheld from this Bot");
    }
  });

  test("withholding is per Bot and reaches no other Bot", async () => {
    // Withholding is scoped to botA and does not affect botB.
    expect((await store.decide(componentName, botA)).allowed).toBeFalse();
    expect((await store.decide(componentName, botB)).allowed).toBeTrue();
  });

  test("an unpublished component is refused to every Bot", async () => {
    const decision = await store.decide(otherName, botB);
    expect(decision.allowed).toBeFalse();
    if (!decision.allowed) {
      expect(decision.reason).toContain("not published");
    }
  });

  test("a component that does not exist is refused rather than throwing", async () => {
    // A model inventing a tool name must get an answer it can act on, not a 500.
    const decision = await store.decide(`nothing_${suite}`, botA);
    expect(decision.allowed).toBeFalse();
    if (!decision.allowed) {
      expect(decision.reason).toContain("no component called");
    }
  });

  test("granting it back restores it", async () => {
    await store.grant(componentName, botA);
    expect((await store.decide(componentName, botA)).allowed).toBeTrue();
  });
});

describe("withholding", () => {
  test("withholding twice does not move the date it was withheld", async () => {
    await store.revoke(componentName, botB, "first@example.test");
    const [first] = await database
      .select()
      .from(componentExclusions)
      .where(eq(componentExclusions.agentId, botB));

    await store.revoke(componentName, botB, "second@example.test");
    const rows = await database
      .select()
      .from(componentExclusions)
      .where(eq(componentExclusions.agentId, botB));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.withheldBy).toBe("first@example.test");
    expect(rows[0]?.withheldAt).toEqual(first?.withheldAt as Date);

    await store.grant(componentName, botB);
  });

  test("withholding a component that does not exist is an error, not a silent row", async () => {
    // Without this a typo in an API call writes a row against nothing, which reads in the grid as a
    // Bot held back from something that was never there.
    expect(
      store.revoke(`nothing_${suite}`, botA, "x@example.test"),
    ).rejects.toThrow(ComponentNotFoundError);
  });

  test("deleting a Bot takes its withholdings with it", async () => {
    const doomed = `agent_test_doomed_${suite}`;
    fixtureAgentIds.add(doomed);
    await database.insert(agents).values({
      id: doomed,
      name: doomed,
      type: "remote_ag_ui",
      configuration: {},
    });
    await store.revoke(componentName, doomed, "x@example.test");

    await database.delete(agents).where(eq(agents.id, doomed));

    const left = await database
      .select()
      .from(componentExclusions)
      .where(eq(componentExclusions.agentId, doomed));
    expect(left).toHaveLength(0);
  });
});

describe("what a Bot holds", () => {
  test("lists the published components, and not the unpublished ones", async () => {
    const held = await store.listForAgent(botA);
    const names = held.map((component) => component.name);

    expect(names).toContain(componentName);
    expect(names).not.toContain(otherName);
  });

  test("a component this Bot is withheld from is left out", async () => {
    await store.revoke(componentName, botA, "x@example.test");

    const names = (await store.listForAgent(botA)).map(
      (component) => component.name,
    );
    expect(names).not.toContain(componentName);
    // And the withholding reaches only this Bot.
    expect(
      (await store.listForAgent(botB)).map((component) => component.name),
    ).toContain(componentName);

    await store.grant(componentName, botA);
  });
});

describe("publishing", () => {
  test("publishing promotes the draft, which is what changes behaviour", async () => {
    await store.saveDraft(componentName, "New wording.", "editor@example.test");

    // Still the old wording: a draft must change nothing until somebody publishes it.
    const before = await store.decide(componentName, botA);
    expect(before.allowed && before.description).toBe("The published wording.");

    await store.publish(componentName, "editor@example.test");
    const after = await store.decide(componentName, botA);
    expect(after.allowed && after.description).toBe("New wording.");
  });

  test("unpublishing keeps the withholdings", async () => {
    await store.revoke(componentName, botA, "x@example.test");
    await store.unpublish(componentName, "editor@example.test");

    const rows = await database
      .select()
      .from(componentExclusions)
      .where(eq(componentExclusions.componentName, componentName));

    // Unpublishing is "nobody may use this for now", not "forget who was held back from it".
    // Clearing them would quietly hand it to a Bot on the next publish.
    expect(rows.length).toBeGreaterThan(0);
    await store.publish(componentName, "editor@example.test");
    await store.grant(componentName, botA);
  });

  test("a draft that matches the published version is not reported as unpublished changes", async () => {
    const listed = (await store.list()).find(
      (component) => component.name === componentName,
    );
    expect(listed?.hasUnpublishedChanges).toBeFalse();
  });
});

describe("learning what a build ships", () => {
  const announced = {
    name: `testAnnounced_${suite}`,
    title: "Announced",
    kind: "card",
    description: "Arrived from a build rather than from a list on the server.",
  };
  fixtureComponentNames.add(announced.name);

  test("a component the deployment has never seen is added, published and available to every Bot", async () => {
    const { added } = await store.syncCatalogue([announced]);
    expect(added).toEqual([announced.name]);

    const stored = (await store.list()).find(
      (component) => component.name === announced.name,
    );
    expect(stored?.published).toBeTrue();
    expect(stored?.withheldFrom).toEqual([]);
    // The point of the whole change: a fresh install can draw without anybody configuring it.
    expect((await store.decide(announced.name, botA)).allowed).toBeTrue();
  });

  test("announcing again adds nothing", async () => {
    // Runs on every page load, so a second call must be a no-op rather than a duplicate-key crash.
    expect((await store.syncCatalogue([announced])).added).toEqual([]);
  });

  test("announcing NEVER overwrites what the deployment decided", async () => {
    await store.saveDraft(
      announced.name,
      "Our own wording.",
      "admin@example.test",
    );
    await store.publish(announced.name, "admin@example.test");
    await store.revoke(announced.name, botA, "admin@example.test");
    await store.unpublish(announced.name, "admin@example.test");

    // The same build announces the same component with its original description, as it would on the
    // next page load. Every one of these would be an upgrade quietly undoing somebody's work.
    await store.syncCatalogue([announced]);

    const stored = (await store.list()).find(
      (component) => component.name === announced.name,
    );
    expect(stored?.publishedDescription).toBe("Our own wording.");
    expect(stored?.published).toBeFalse();
    expect(stored?.withheldFrom).toEqual([botA]);
  });

  test("two browsers announcing at once add it once, and record it once", async () => {
    /*
     * The insert has always been safe: `onConflictDoNothing` is there because two page loads racing
     * is ordinary. What was not safe was the answer. `added` reported what the call had *tried* to
     * insert, so the loser of that ordinary race named every component anyway, and the caller writes
     * one audit row per name. A first start with two tabs open recorded all thirteen shipped
     * components twice, in the trail whose whole value is that it says what happened once.
     *
     * Concurrent rather than sequential on purpose: the sequential case was always covered by
     * "announcing again adds nothing", and it passed throughout.
     */
    const racer = {
      name: `testRaced_${suite}`,
      title: "Raced",
      kind: "card",
      description: "Announced by two page loads at the same moment.",
    };
    fixtureComponentNames.add(racer.name);

    const [first, second] = await Promise.all([
      store.syncCatalogue([racer]),
      store.syncCatalogue([racer]),
    ]);

    const named = [...first.added, ...second.added];
    expect(named).toEqual([racer.name]);

    const rows = (await store.list()).filter((one) => one.name === racer.name);
    expect(rows).toHaveLength(1);
  });

  test("announcing nothing is not a request to forget everything", async () => {
    // A build with no components, or a failed manifest, must not empty the catalogue.
    const before = (await store.list()).length;
    expect((await store.syncCatalogue([])).added).toEqual([]);
    expect((await store.list()).length).toBe(before);
  });
});

describe("what a component may read", () => {
  const fn = "botActivity";
  const other = "recentRefusals";

  test("a component granted nothing may read nothing", async () => {
    // The state every component is in the moment it is added, which is why this is the first test.
    expect(await store.mayCall(componentName, fn)).toBeFalse();
    expect(await store.mayCall(componentName, other)).toBeFalse();
  });

  test("a granted function is allowed and the others still are not", async () => {
    await store.grantFunction(componentName, fn, "admin@example.test");

    expect(await store.mayCall(componentName, fn)).toBeTrue();
    // The interesting half: granting one function must not grant the next one along.
    expect(await store.mayCall(componentName, other)).toBeFalse();
  });

  test("a grant reaches only the component it was given to", async () => {
    expect(await store.mayCall(otherName, fn)).toBeFalse();
  });

  test("granting twice does not move the date it was granted", async () => {
    const [first] = await database
      .select()
      .from(componentFunctions)
      .where(eq(componentFunctions.componentName, componentName));

    await store.grantFunction(componentName, fn, "somebody-else@example.test");
    const rows = await database
      .select()
      .from(componentFunctions)
      .where(eq(componentFunctions.componentName, componentName));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.grantedBy).toBe("admin@example.test");
    expect(rows[0]?.grantedAt).toEqual(first?.grantedAt as Date);
  });

  test("revoking takes it away again", async () => {
    await store.revokeFunction(componentName, fn);
    expect(await store.mayCall(componentName, fn)).toBeFalse();
  });

  test("revoking from a component that does not exist is an error, not a silent no-op", async () => {
    // A grant cannot outlive its component, so there is nothing to take away; saying so beats
    // reporting a revoke of something that was never there.
    expect(store.revokeFunction(`nothing_${suite}`, fn)).rejects.toThrow(
      ComponentNotFoundError,
    );
  });

  test("deleting a component takes its function grants with it", async () => {
    const doomed = `testDoomed_${suite}`;
    await makeComponent(doomed, true);
    await store.grantFunction(doomed, fn, "admin@example.test");

    await database.delete(components).where(eq(components.name, doomed));

    const left = await database
      .select()
      .from(componentFunctions)
      .where(eq(componentFunctions.componentName, doomed));
    expect(left).toHaveLength(0);
  });

  test("a function this build does not ship cannot be run", async () => {
    expect(store.callFunction(`nothing_${suite}`, {})).rejects.toThrow();
  });
});
