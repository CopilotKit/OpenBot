import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  CreateBotBody,
  UpdateBotBody,
} from "../app/src/lib/api/generated/bots/bots.zod";

/**
 * The Bots and Team Bots operations each ask for their own resource's scope: a read for a GET, a
 * write for anything else. An app given bots:read can see what a Bot is doing for its person, but
 * cannot pause it, reset it or publish it; one given team-bots:write can publish without being able to
 * change the Bot itself. These hold every operation to that, the per-person ones under people/ too.
 */

type Operation = { security?: Record<string, string[]>[] };
type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components: {
    securitySchemes: {
      appOAuth: {
        flows: { authorizationCode: { scopes: Record<string, string> } };
      };
    };
  };
};

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as Spec;
/** The Bots area's own file: other areas keep addresses under a Bot too (its follow-ups, its shared use). */
const area = parse(
  readFileSync(join(import.meta.dir, "openapi", "bots.yaml"), "utf8"),
) as Pick<Spec, "paths">;
const ORGANIZATION = "/api/v2/organizations/{organizationId}/";
const METHODS = ["get", "post", "put", "patch", "delete"];

/** The resource whose scope an address of the Bots area asks for. */
function resourceOf(path: string): "bots" | "team-bots" {
  const rest = path.slice(ORGANIZATION.length);
  return rest.startsWith("team-bots") ||
    rest.endsWith("/clear-team-bot-consents")
    ? "team-bots"
    : "bots";
}

function operations() {
  const found: { path: string; method: string; scopes: string[] }[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    if (!(path in area.paths)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const scopes =
        operation.security?.find((entry) => "appOAuth" in entry)?.appOAuth ??
        [];
      found.push({ path, method, scopes });
    }
  }
  return found;
}

test("every Bots and Team Bots operation asks for its resource's read or write scope", () => {
  const all = operations();
  // The five Bot operations, the rest of a Bot's, a person's attention, and every Team Bot one.
  expect(all.length).toBeGreaterThanOrEqual(30);
  for (const { path, method, scopes } of all) {
    const resource = resourceOf(path);
    expect({ path, method, scopes }).toEqual({
      path,
      method,
      scopes: [`${resource}:${method === "get" ? "read" : "write"}`],
    });
  }
});

test("every scope those operations ask for is one an app can be given", () => {
  const offered = Object.keys(
    spec.components.securitySchemes.appOAuth.flows.authorizationCode.scopes,
  );
  for (const { scopes } of operations())
    for (const scope of scopes) expect(offered).toContain(scope);
});

/*
 * A Bot's instructions hold up to 5000 characters. They were capped at 1000, which a person writing
 * real instructions for a Bot ran into. Both places they are written: what it does, which a Bot
 * with no address runs on, and the starter Bot's own instructions.
 */
test("a Bot's instructions take up to 5000 characters, on create and on a change", () => {
  const bot = {
    name: "Expense Review",
    title: "",
    roleDescription: "Review receipts.",
    visibility: "private",
  };
  for (const body of [CreateBotBody, UpdateBotBody]) {
    for (const field of ["roleDescription", "instructions"]) {
      expect(
        body.safeParse({ ...bot, [field]: "r".repeat(4999) }).success,
      ).toBe(true);
      expect(
        body.safeParse({ ...bot, [field]: "r".repeat(5000) }).success,
      ).toBe(true);
      expect(
        body.safeParse({ ...bot, [field]: "r".repeat(5001) }).success,
      ).toBe(false);
    }
  }
});
