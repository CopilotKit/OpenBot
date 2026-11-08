import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type ArcadeActions,
  listTools as listArcadeTools,
  useArcadeClient,
} from "../src/plugins/arcade";
import {
  listTools as listComposioTools,
  useComposioClient,
} from "../src/plugins/composio";
import {
  buildComposioClient,
  type ComposioVendor,
} from "../src/plugins/composio-adapter";
import type { ListedTool } from "../src/plugins/mcp";
import { storableSchema } from "../src/plugins/plugin-store/model";
import type { PluginStore } from "../src/plugins/store";
import { grantedTools } from "../src/plugins/tools";
import fixture from "./fixtures/provider-schema-tools.json";
import { providerSchemaFaults } from "./support/provider-schema-rules";

/**
 * Every app tool a Bot is offered fits the JSON Schema a model provider accepts.
 *
 * FOUND LIVE. A Bot on the LangGraph harness, signed in to a ChatGPT plan, answered every message
 * that brought Gmail up with "Remote agent ended without a terminal event." The harness log held
 * the reason: the Codex backend had refused the request with "Invalid JSON schema: regex lookaround
 * is not supported. Found at $.properties.email_address.pattern." The schema it refused was not one
 * any app wrote. HubSpot's HUBSPOT_GET_EMAIL_SUBSCRIPTION_STATUS, one of the tools a search for
 * "email" finds, says `email_address: {"type": "string", "format": "email"}`; OpenBot read that as
 * `z.email()` and wrote it back out for the harness with zod's email regex, which opens with two
 * negative lookaheads.
 *
 * THE PATH IS THE ONE A RUN TAKES. Each row below is the vendor's own, captured from its live
 * listing (`fixtures/provider-schema-tools.json`). It goes through the real Composio or Arcade
 * listing, the store's `storableSchema`, `grantedTools`, and `z.toJSONSchema`, which is what the
 * server sends every harness (`copilot.ts`) and what the AI SDK sends a provider for a built-in
 * Bot. What comes out is checked against the providers' documented rules
 * (`support/provider-schema-rules.ts`).
 */

afterEach(() => {
  useComposioClient(null);
  useArcadeClient(null);
});

type WireRow = { slug: string; [key: string]: unknown };

const refuse = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} should not have been called in this test.`);
};

/** Composio for one app's captured rows, answering the listing and nothing else. */
function composioWith(toolkit: string, rows: WireRow[]): ComposioVendor {
  return {
    tools: {
      list: async (query: { toolkit_slug?: string }) => ({
        items: query.toolkit_slug === toolkit ? structuredClone(rows) : [],
        next_cursor: null,
      }),
      getRawComposioToolBySlug: refuse("getRawComposioToolBySlug"),
      execute: refuse("execute"),
    },
    toolkits: {
      list: refuse("toolkits.list"),
      retrieve: refuse("toolkits.retrieve"),
    },
    authConfigs: {
      list: refuse("authConfigs.list"),
      create: refuse("authConfigs.create"),
      delete: refuse("authConfigs.delete"),
    },
    connectedAccounts: {
      list: refuse("connectedAccounts.list"),
      link: refuse("connectedAccounts.link"),
      create: refuse("connectedAccounts.create"),
      delete: refuse("connectedAccounts.delete"),
    },
  } as unknown as ComposioVendor;
}

/** Arcade for one toolkit's captured rows, answering the listing and nothing else. */
function arcadeWith(toolkit: string, rows: unknown[]): ArcadeActions {
  return {
    listTools: async (query) => {
      const items = query.toolkit === toolkit ? structuredClone(rows) : [];
      return {
        items: items.slice(query.offset, query.offset + query.limit),
        total_count: items.length,
      };
    },
    execute: refuse("execute"),
  };
}

/** What a harness is sent for each of these tools, by the name the vendor gave it. */
async function sentToHarness(
  server: string,
  listed: ListedTool[],
): Promise<Map<string, Record<string, unknown>>> {
  const store = {
    listForAgent: async () => ({
      tools: listed.map((tool) => ({
        toolName: `mcp__${server}__${tool.name}`,
        ref: `${server}/${tool.name}`,
        description: tool.description,
        inputSchema: storableSchema(tool.inputSchema),
      })),
    }),
    callTool: refuse("callTool"),
  } as unknown as PluginStore;
  const granted = await grantedTools({ store, botId: "bot", actorId: "usr" });
  return new Map(
    granted.map((tool) => [
      tool.ref.slice(server.length + 1),
      z.toJSONSchema(tool.parameters) as Record<string, unknown>,
    ]),
  );
}

const composio = fixture.composio as Record<string, WireRow[]>;
const arcade = fixture.arcade as Record<string, unknown[]>;

async function composioSchemas(toolkit: string) {
  const rows = composio[toolkit] ?? [];
  useComposioClient(buildComposioClient(composioWith(toolkit, rows)).actions);
  const listed = await listComposioTools({ url: `composio://${toolkit}` });
  expect(listed.map((tool) => tool.name).sort()).toEqual(
    rows.map((row) => row.slug).sort(),
  );
  return sentToHarness(`composio-${toolkit}`, listed);
}

function property(schema: Record<string, unknown> | undefined, name: string) {
  const properties = schema?.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  return properties?.[name];
}

describe("what a harness is sent for an app's tools", () => {
  test.each(Object.keys(composio))(
    "Composio's %s tools fit what the model providers accept",
    async (toolkit) => {
      const schemas = await composioSchemas(toolkit);
      for (const [slug, schema] of schemas)
        expect({ slug, faults: providerSchemaFaults(schema) }).toEqual({
          slug,
          faults: [],
        });
    },
  );

  test.each(Object.keys(arcade))(
    "Arcade's %s tools fit what the model providers accept",
    async (toolkit) => {
      useArcadeClient(arcadeWith(toolkit, arcade[toolkit] ?? []));
      const listed = await listArcadeTools({ url: `arcade://${toolkit}` });
      expect(listed).toHaveLength(arcade[toolkit]?.length ?? -1);
      const schemas = await sentToHarness(`arcade-${toolkit}`, listed);
      for (const [name, schema] of schemas)
        expect({ name, faults: providerSchemaFaults(schema) }).toEqual({
          name,
          faults: [],
        });
    },
  );

  test("an email address goes out with no lookaround, and says it is an email address", async () => {
    const schemas = await composioSchemas("hubspot");
    for (const slug of [
      "HUBSPOT_GET_EMAIL_SUBSCRIPTION_STATUS",
      "HUBSPOT_GET_COMMUNICATION_STATUS",
      "HUBSPOT_UPDATE_EMAIL_SUBSCRIPTIONS",
    ]) {
      const email = property(schemas.get(slug), "email_address");
      // Every key the property goes out with, so neither `pattern` nor `format` is among them.
      expect({ slug, keys: Object.keys(email ?? {}).sort() }).toEqual({
        slug,
        keys: ["description", "examples", "title", "type"],
      });
      expect(email?.type).toBe("string");
      expect(String(email?.description)).toEndWith("Format: email.");
    }
  });

  test("an app's own lookaround goes into the description, and a plain pattern stays", async () => {
    const exa = property(
      (await composioSchemas("exa")).get("EXA_GET_WEBSET"),
      "id",
    );
    expect(Object.keys(exa ?? {}).sort()).toEqual([
      "description",
      "minLength",
      "title",
      "type",
    ]);
    expect(String(exa?.description)).toContain(
      "Must match the regular expression ^(?!\\.{1,2}$)[A-Za-z0-9._:-]+$",
    );

    const gmail = (await composioSchemas("gmail")).get(
      "GMAIL_ADD_LABEL_TO_EMAIL",
    );
    expect(property(gmail, "message_id")?.pattern).toBe("^[0-9a-fA-F]+$");
  });

  test.each([
    // An object with alternatives beside its own properties, which zod read as an intersection.
    ["braze", "BRAZE_IDENTIFY_USERS"],
    // Definitions under draft-07's `definitions`, which zod could not resolve.
    ["plain_mcp", "PLAIN_MCP_GET_THREADS"],
  ])(
    "%s's %s is offered with its arguments named, not as an open object",
    async (toolkit, slug) => {
      const row = composio[toolkit]?.find(
        (candidate) => candidate.slug === slug,
      );
      const published = Object.keys(
        ((row?.input_parameters as Record<string, unknown>)?.properties ??
          {}) as object,
      );
      const sent = (await composioSchemas(toolkit)).get(slug);
      expect(published.length).toBeGreaterThan(0);
      expect(Object.keys((sent?.properties ?? {}) as object)).toEqual(
        expect.arrayContaining(published),
      );
    },
  );
});
