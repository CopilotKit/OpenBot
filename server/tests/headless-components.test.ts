import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { z } from "zod";
import { GALLERY as ACTIVITY } from "../../app/src/components/gallery/activity";
import { GALLERY as CARDS } from "../../app/src/components/gallery/cards";
import { GALLERY as CHARTS } from "../../app/src/components/gallery/charts";
import { GALLERY as DECISIONS } from "../../app/src/components/gallery/decisions";
import { GALLERY as FORM } from "../../app/src/components/gallery/form";
import { GALLERY as QUOTE } from "../../app/src/components/gallery/quote";
import { GALLERY as TABLE } from "../../app/src/components/gallery/table";
import { NOT_SHOWN } from "../../shared/component-markers";
import type { AuditEventInput } from "../src/audit";
import {
  createHeadlessComponentTools,
  HEADLESS_COMPONENTS,
} from "../src/components/headless";
import type {
  ComponentDecision,
  ComponentStore,
} from "../src/components/store";

/**
 * The server's copy of each chart schema must be the app's, or a headless turn would record a call
 * the browser's renderer reads differently. Compared as JSON Schema, which is what the model is given.
 */
/** Every gallery module. A new file under components/gallery must be added here. */
const GALLERY = [
  ...ACTIVITY,
  ...CARDS,
  ...CHARTS,
  ...DECISIONS,
  ...FORM,
  ...QUOTE,
  ...TABLE,
];

describe("headless components mirror the compiled gallery", () => {
  test("every gallery module is listed here", async () => {
    const files = [
      ...new Bun.Glob("*.tsx").scanSync(
        join(import.meta.dir, "../../app/src/components/gallery"),
      ),
    ];
    const declaring = [];
    for (const file of files) {
      const source = await Bun.file(
        join(import.meta.dir, "../../app/src/components/gallery", file),
      ).text();
      if (source.includes("export const GALLERY")) declaring.push(file);
    }
    expect(declaring.sort()).toEqual([
      "activity.tsx",
      "cards.tsx",
      "charts.tsx",
      "decisions.tsx",
      "form.tsx",
      "quote.tsx",
      "table.tsx",
    ]);
  });

  test("every compiled display component is mirrored with the same parameter schema", () => {
    const display = GALLERY.filter((entry) => entry.kind !== "decision");
    expect(HEADLESS_COMPONENTS.map((spec) => spec.name).sort()).toEqual(
      display.map((entry) => entry.name).sort(),
    );
    for (const entry of display) {
      const mirror = HEADLESS_COMPONENTS.find(
        (spec) => spec.name === entry.name,
      );
      expect(mirror?.title).toBe(entry.title);
      expect(z.toJSONSchema(mirror?.parameters as z.ZodType)).toEqual(
        z.toJSONSchema(entry.parameters as z.ZodType),
      );
    }
  });

  test("a mirrored component reads the same data functions as the app's", () => {
    for (const entry of GALLERY.filter((item) => item.reads)) {
      const mirror = HEADLESS_COMPONENTS.find(
        (spec) => spec.name === entry.name,
      );
      for (const args of [
        { report: "activity" },
        { report: "refusals" },
        { report: "other" },
        {},
      ])
        expect(mirror?.reads?.(args) ?? []).toEqual(entry.reads?.(args) ?? []);
    }
  });

  test("the table's cross-field rule is enforced headlessly too", () => {
    const table = HEADLESS_COMPONENTS.find((spec) => spec.name === "showTable");
    expect(
      table?.parameters.safeParse({
        title: "T",
        columns: ["A", "B"],
        rows: [{ cells: [1] }],
      }).success,
    ).toBeFalse();
    expect(
      table?.parameters.safeParse({
        title: "T",
        columns: ["A", "B"],
        rows: [{ cells: [1, "x"] }],
      }).success,
    ).toBeTrue();
  });

  test("arguments a headless turn accepts draw the real chart with the app's renderer", async () => {
    const appRequire = createRequire(join(import.meta.dir, "../../app/"));
    const { createElement } = appRequire("react") as typeof import("react");
    const { renderToStaticMarkup } = appRequire(
      "react-dom/server",
    ) as typeof import("react-dom/server");
    const args = {
      title: "Open issues by team",
      points: [
        { label: "Platform", value: 12 },
        { label: "Apps", value: 5 },
      ],
    };
    const mirror = HEADLESS_COMPONENTS.find(
      (spec) => spec.name === "showBarChart",
    );
    expect(mirror?.parameters.safeParse(args).success).toBeTrue();
    const Component = GALLERY.find(
      (entry) => entry.name === "showBarChart",
    )?.Component;
    if (!Component) throw new Error("The app has no bar chart renderer.");
    const html = renderToStaticMarkup(createElement(Component, args));
    expect(html).toContain("Open issues by team");
    expect(html).toContain("Platform");
    expect(html).toContain("Apps");
    // Two bars, the larger at full height.
    expect(html).toContain("height:100%");
  });
});

function fakeStore(decision: ComponentDecision): ComponentStore {
  return {
    listForAgent: async () =>
      decision.allowed
        ? [{ name: "showBarChart", description: decision.description }]
        : [],
    decide: async () => decision,
    mayCall: async () => false,
  } as unknown as ComponentStore;
}

describe("headless component tools", () => {
  const initiator = { kind: "routine" as const, id: "routine-1" };
  const valid = { title: "Revenue", points: [{ label: "Q1", value: 3 }] };

  test("a held chart is offered with its published description and records a confirmation", async () => {
    const tools = await createHeadlessComponentTools({
      store: fakeStore({ allowed: true, description: "Published wording." }),
      botId: "bot",
      ownerUserId: "owner",
      initiator,
    });
    const bar = tools.find((tool) => tool.definition.name === "showBarChart");
    expect(bar?.hidden).toBeUndefined();
    expect(bar?.definition.description).toBe("Published wording.");
    await expect(
      bar?.execute(valid, {
        toolCallId: "c",
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(
      "The bar chart is saved in this conversation and is drawn when the person opens it.",
    );
    // Components the Bot does not hold are registered but never offered.
    expect(
      tools.find((tool) => tool.definition.name === "showLineChart")?.hidden,
    ).toBeTrue();
  });

  test("invalid arguments and a refused decision are recorded as not shown and audited", async () => {
    const audit: AuditEventInput[] = [];
    const auditStore = {
      insert: async (event: AuditEventInput) => {
        audit.push(event);
      },
    };
    const refused = await createHeadlessComponentTools({
      store: fakeStore({
        allowed: false,
        reason: "Bar chart has been withheld from this Bot.",
      }),
      botId: "bot",
      ownerUserId: "owner",
      initiator,
      auditStore,
    });
    const bar = refused.find((tool) => tool.definition.name === "showBarChart");
    expect(bar?.hidden).toBeTrue();
    const context = { toolCallId: "c", signal: new AbortController().signal };
    const invalid = String(await bar?.execute({ title: 1 }, context));
    expect(invalid.startsWith(`${NOT_SHOWN}Bar chart. `)).toBeTrue();
    expect(invalid).toContain("does not match its declared shape");
    const denied = String(await bar?.execute(valid, context));
    expect(denied).toBe(
      `${NOT_SHOWN}Bar chart. Bar chart has been withheld from this Bot. Nothing was displayed, so tell the person that.`,
    );
    expect(audit).toEqual([
      expect.objectContaining({
        eventType: "component.refused",
        targetId: "showBarChart",
        actorUserId: "owner",
        initiator,
        payload: expect.objectContaining({ bot: "bot", invalid: true }),
      }),
      expect.objectContaining({
        eventType: "component.refused",
        initiator,
        payload: expect.objectContaining({
          reason: "Bar chart has been withheld from this Bot.",
          headless: true,
        }),
      }),
    ]);
  });

  test("a component that reads ungranted data is refused before it is recorded", async () => {
    const tools = await createHeadlessComponentTools({
      store: fakeStore({ allowed: true, description: "Reads." }),
      botId: "bot",
      ownerUserId: "owner",
      initiator,
      specs: [
        {
          ...(HEADLESS_COMPONENTS.find(
            (spec) => spec.name === "showBarChart",
          ) as (typeof HEADLESS_COMPONENTS)[number]),
          reads: () => ["auditSummary"],
        },
      ],
    });
    const result = String(
      await tools[0]?.execute(valid, {
        toolCallId: "c",
        signal: new AbortController().signal,
      }),
    );
    expect(result).toContain("has not been granted the function auditSummary");
    expect(result.startsWith(NOT_SHOWN)).toBeTrue();
  });
});
