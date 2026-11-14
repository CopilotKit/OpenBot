import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * The connections API describes two holders of one kind of thing: a person's own connection to an app,
 * and an app's one shared account. Both are served by the same rules, so these hold the spec to that:
 * the two answer alike, each says who may act on it, and nothing a caller sends can name where a person
 * lands after a consent page.
 */

type Node = Record<string, unknown>;
type Operation = {
  operationId: string;
  tags?: string[];
  requestBody?: Node;
  responses: Record<string, Node>;
};
type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components: Record<string, Record<string, Node>>;
};

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as Spec;

const ORG = "/api/v2/organizations/{organizationId}";
const PERSON = `${ORG}/people/{personId}/connections`;
const SHARED = `${ORG}/apps/{appId}/shared-connection`;
const METHODS = ["get", "post", "put", "patch", "delete"];

const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  METHODS.flatMap((method) => {
    const operation = item[method];
    return operation?.tags?.includes("Connections")
      ? [{ path, method, operation }]
      : [];
  }),
);
const byId = new Map(
  operations.map((entry) => [entry.operation.operationId, entry]),
);

/** The component a `$ref` names. */
function target(ref: string): Node {
  const [, , kind, name] = ref.split("/");
  const found = spec.components[kind ?? ""]?.[name ?? ""];
  expect(found).toBeDefined();
  return found as Node;
}

/** Every node reachable from `start`, following `$ref`s, each component once. */
function reachable(start: unknown): Node[] {
  const seen = new Set<string>();
  const nodes: Node[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    const node = value as Node;
    nodes.push(node);
    if (typeof node.$ref === "string") {
      if (seen.has(node.$ref)) return;
      seen.add(node.$ref);
      walk(target(node.$ref));
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(start);
  return nodes;
}

const answer = (operationId: string, status = "200") => {
  const entry = byId.get(operationId);
  expect(entry).toBeDefined();
  const content = entry?.operation.responses[status]?.content as
    | Record<string, { schema?: Node }>
    | undefined;
  return content?.["application/json"]?.schema?.$ref;
};

test("every connections operation sits under a person's connections or an app's shared account", () => {
  expect(operations.length).toBe(19);
  for (const { path } of operations) {
    expect(path.startsWith(PERSON) || path.startsWith(SHARED)).toBe(true);
  }
});

test("a Shared app's account answers each act as a person's own does", () => {
  const pairs: [string, string][] = [
    ["connectApp", "connectSharedApp"],
    ["confirmConnection", "confirmSharedConnection"],
    ["recheckConnection", "recheckSharedConnection"],
    ["disconnectApp", "disconnectSharedApp"],
    ["getConnectionAuthorizations", "getSharedConnectionAuthorizations"],
    ["authorizeConnectionAction", "authorizeSharedConnectionAction"],
  ];
  for (const [own, shared] of pairs) {
    expect(answer(own)).toBeString();
    expect(answer(shared)).toBe(answer(own) as string);
  }
});

test("a person's connections answer only that person, and a shared account's writes only an admin", () => {
  for (const { path, method, operation } of operations) {
    const forbidden = operation.responses["403"]?.$ref;
    if (path.startsWith(PERSON)) {
      expect([
        "#/components/responses/OwnOnly",
        "#/components/responses/ConnectionForbidden",
      ]).toContain(forbidden as string);
    } else if (method === "post") {
      expect(forbidden).toBe("#/components/responses/AdminOnly");
    } else {
      expect(forbidden).toBe("#/components/responses/Forbidden");
    }
  }
});

test("nothing a caller sends names an address: the way back is one of OpenBot's own pages", () => {
  for (const { operation } of operations) {
    for (const node of reachable(operation.requestBody)) {
      expect(node.format).not.toBe("uri");
      for (const name of Object.keys(
        (node.properties as Node | undefined) ?? {},
      )) {
        expect(name).not.toMatch(/url|uri|address/i);
      }
    }
  }
  for (const name of ["ConnectionReturnTo", "SharedConnectionReturnTo"]) {
    const pages = spec.components.schemas?.[name]?.enum as string[];
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) expect(page).toMatch(/^[a-z]+$/);
  }
});

test("no connections operation, field or example names the service apps are reached through", () => {
  for (const { operation } of operations) {
    expect(JSON.stringify(reachable(operation))).not.toMatch(
      /composio|arcade/i,
    );
  }
});
