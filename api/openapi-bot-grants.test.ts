import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * A Bot's grants are addressed by an id that names their kind, and the kinds a grant id may name are
 * the kinds a grant is listed with. And every operation of the Bot grants and app access request areas
 * asks for its own area's permission: reading, or describing and testing a change, needs `:read`;
 * changing anything needs `:write`. The server reads the same rule to decide which permission an
 * app's sign-in needs, so the two can't drift apart unnoticed.
 */

type Parameter = {
  name?: string;
  in?: string;
  schema?: { pattern?: string };
};
type Operation = {
  operationId: string;
  tags?: string[];
  security?: Record<string, string[]>[];
};
type PathItem = { parameters?: Parameter[] } & Record<string, unknown>;

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as {
  paths: Record<string, PathItem>;
  components: { schemas: Record<string, { enum?: string[] }> };
};

const ORGANIZATION = "/api/v2/organizations/{organizationId}";
const METHODS = ["get", "put", "post", "patch", "delete"] as const;

/** Each operation in the spec, with its path and method. */
function operations() {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const operation = item[method] as Operation | undefined;
      return operation ? [{ path, method, operation }] : [];
    }),
  );
}

test("a grant id names exactly the kinds a grant is listed with", () => {
  const grant = spec.paths[`${ORGANIZATION}/bots/{botId}/grants/{grantId}`];
  const grantId = grant?.parameters?.find(
    (parameter) => parameter.name === "grantId",
  );
  const pattern = grantId?.schema?.pattern ?? "";
  const named = [...pattern.matchAll(/([a-z]+):/g)].map((match) => match[1]);

  expect(named.sort()).toEqual(
    [...(spec.components.schemas.BotGrantKind?.enum ?? [])].sort(),
  );
  const id = new RegExp(pattern);
  expect(id.test("action:notion:notion-search")).toBe(true);
  expect(id.test("skill:weekly-report")).toBe(true);
  expect(id.test("bot:writer")).toBe(true);
  expect(id.test("action:notion/notion-search")).toBe(false);
  expect(id.test("tool:notion")).toBe(false);
});

test("each operation asks for its area's permission, read to look and write to change", () => {
  const areas: Record<string, string> = {
    "Bot grants": "bot-grants",
    "App access requests": "app-access-requests",
  };
  // Describing a change and testing one save nothing, as network-policies' translate and replay.
  const readsToo = new Set(["translateBotGrants", "replayBotGrants"]);
  const checked = operations().filter(({ operation }) =>
    operation.tags?.some((tag) => tag in areas),
  );

  expect(checked.map(({ operation }) => operation.operationId).sort()).toEqual(
    [
      "approveAppAccessRequest",
      "approveBotApp",
      "batchUpdateBotGrants",
      "createAppAccessRequest",
      "deleteAppAccessRequest",
      "deleteBotGrant",
      "dismissAppAccessRequest",
      "getAppTeamGrants",
      "getBotApp",
      "giveBotApp",
      "listAppAccessRequests",
      "listBotApps",
      "listBotGrants",
      "listGiveableApps",
      "replaceAppTeamGrants",
      "replaceBotGrant",
      "replayBotGrants",
      "takeBackBotApp",
      "translateBotGrants",
    ].sort(),
  );
  for (const { method, operation } of checked) {
    const area = areas[operation.tags?.[0] ?? ""];
    const reads = method === "get" || readsToo.has(operation.operationId);
    const scopes = operation.security?.find(
      (entry) => "appOAuth" in entry,
    )?.appOAuth;
    expect({ operation: operation.operationId, scopes }).toEqual({
      operation: operation.operationId,
      scopes: [`${area}:${reads ? "read" : "write"}`],
    });
  }
});
