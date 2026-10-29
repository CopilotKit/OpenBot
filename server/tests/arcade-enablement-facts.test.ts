import { afterEach, describe, expect, test } from "bun:test";
import Arcade from "@arcadeai/arcadejs";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import type { BrokerApp } from "../src/plugins/broker";
import fixture from "./fixtures/arcade-catalogue.json";

/**
 * The three enablement facts `listApps` measures beside `actionCount`: how many actions Arcade
 * classified, how many distinct non-empty scope sets they ask for, and how many carry a scope.
 *
 * MEASURED INSIDE THE EXISTING FOLD. `listApps` already pages `tools.list` to the end and folds
 * every tool into a per-toolkit `actionCount` before discarding the tools; these three are counted
 * before that discard. No second listing, no extra vendor call — which `asked` asserts below.
 */
type Methods = Record<string, (...args: unknown[]) => unknown>;
const toolsProto = (): Methods =>
  Object.getPrototypeOf(
    new Arcade({ apiKey: "never-dialled" }).tools,
  ) as Methods;

const restores: (() => void)[] = [];
function stub(
  on: Methods,
  name: string,
  impl: (...args: unknown[]) => unknown,
) {
  const was = on[name];
  on[name] = impl;
  restores.push(() => {
    on[name] = was;
  });
}
afterEach(() => {
  while (restores.length) restores.pop()?.();
});

/** Serves one page of `items` and records every offset asked for. */
function serving(items: unknown[]): { asked: number[] } {
  const asked: number[] = [];
  stub(toolsProto(), "list", (...args: unknown[]) => {
    const q = args[0] as { offset: number };
    asked.push(q.offset);
    return Promise.resolve(
      q.offset === 0
        ? { items, total_count: items.length }
        : { items: [], total_count: items.length },
    );
  });
  return { asked };
}

const listed = async () =>
  await createArcadeClient("never-dialled").broker.listApps();

const appOf = (apps: BrokerApp[], slug: string): BrokerApp => {
  const app = apps.find((a) => a.slug === slug);
  if (!app) throw new Error(`no app ${slug} in the directory`);
  return app;
};

/**
 * THE FIXTURE IS EVIDENCE ABOUT WHAT ARCADE RETURNS, so it is read and never appended to. Its five
 * tools are verbatim live shapes: three classified toolkits, one unclassified one, and inside that
 * one the mixed case (one action with a scope, one with an empty `oauth2` block).
 */
const FIXTURE_TOOLS = Object.values(
  fixture.tools as Record<string, unknown>,
) as unknown[];

describe("listApps measures the enablement facts from the fixture", () => {
  test("classifiedCount equals actionCount where Arcade published a behavior", async () => {
    const { asked } = serving(FIXTURE_TOOLS);
    const apps = await listed();
    // No second listing: one short page ended it.
    expect(asked).toEqual([0]);
    for (const slug of ["Apollo", "Asana", "Attio"]) {
      const app = appOf(apps, slug);
      expect(app.classifiedCount).toBe(app.actionCount);
    }
  });

  test("classifiedCount is 0 for a toolkit Arcade published no behavior for", async () => {
    serving(FIXTURE_TOOLS);
    const app = appOf(await listed(), "AirtableApi");
    expect(app.actionCount).toBe(2);
    // NEVER THE `Api` SUFFIX: the zero comes from `metadata: null` on both of its actions.
    expect(app.classifiedCount).toBe(0);
  });

  test("permissionCount is 0 where no action carries an oauth2 block at all", async () => {
    serving(FIXTURE_TOOLS);
    const app = appOf(await listed(), "Apollo");
    expect(app.permissionCount).toBe(0);
    expect(app.scopedActionCount).toBe(0);
  });

  test("permissionCount is 1 for a toolkit whose actions share one scope set", async () => {
    serving(FIXTURE_TOOLS);
    const apps = await listed();
    for (const slug of ["Asana", "Attio"]) {
      const app = appOf(apps, slug);
      expect(app.permissionCount).toBe(1);
      expect(app.scopedActionCount).toBe(1);
      expect(app.actionCount).toBe(1);
    }
  });

  /**
   * THE MIXED CASE, and the reason `scopedActionCount` exists. `AirtableApi` publishes
   * `AddBaseCollaborator` with `workspacesAndBases:write` and `ListBases` with an EMPTY `oauth2`
   * block. Without the third number this reads as one permission covering both actions; with it,
   * the second is what it is — covered by any approval at all, and not separately approvable.
   */
  test("a scopeless action joins no permission group", async () => {
    serving(FIXTURE_TOOLS);
    const app = appOf(await listed(), "AirtableApi");
    expect(app.actionCount).toBe(2);
    expect(app.permissionCount).toBe(1);
    expect(app.scopedActionCount).toBe(1);
  });
});

/**
 * `permissionCount > 1` IS A PURE COUNTING PROPERTY AND NEEDS NO REALISM, so it is constructed
 * here rather than appended to the fixture. The fixture's value is that it is what Arcade actually
 * returned; a second append makes that claim slightly less true while the file still carries it.
 */
describe("listApps counts distinct scope sets", () => {
  const scoped = (name: string, scopes: string[]) => ({
    qualified_name: `Constructed.${name}`,
    toolkit: { name: "Constructed", description: "constructed" },
    metadata: { behavior: { read_only: true, destructive: false } },
    requirements: {
      authorization: { provider_type: "oauth2", oauth2: { scopes } },
    },
  });

  test("two distinct scope sets answer permissionCount 2", async () => {
    const tools = [scoped("One", ["a", "b"]), scoped("Two", ["c"])];
    serving(tools);
    const app = appOf(await listed(), "Constructed");
    expect(app.actionCount).toBe(2);
    expect(app.permissionCount).toBe(2);
    expect(app.scopedActionCount).toBe(2);
    expect(app.classifiedCount).toBe(2);
  });

  /** SORTED BEFORE JOINED: `[a,b]` and `[b,a]` are the same permission, asked for twice. */
  test("the same scopes in a different order are ONE permission", async () => {
    const tools = [scoped("One", ["a", "b"]), scoped("Two", ["b", "a"])];
    serving(tools);
    const app = appOf(await listed(), "Constructed");
    expect(app.actionCount).toBe(2);
    expect(app.permissionCount).toBe(1);
    expect(app.scopedActionCount).toBe(2);
  });

  /** Three actions, two sets, one of them reordered: the order never adds a permission. */
  test("sorting does not collapse genuinely different sets", async () => {
    const tools = [
      scoped("One", ["a", "b"]),
      scoped("Two", ["b", "a"]),
      scoped("Three", ["a", "c"]),
    ];
    serving(tools);
    const app = appOf(await listed(), "Constructed");
    expect(app.actionCount).toBe(3);
    expect(app.permissionCount).toBe(2);
    expect(app.scopedActionCount).toBe(3);
  });
});
