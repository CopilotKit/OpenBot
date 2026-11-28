import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  FinishPersonalAiSignInBody,
  FinishPersonalAiSignInResponse,
  GetAiConnectionResponse,
  GetPersonalAiConnectionResponse,
  GetPersonalAiSignInResponse,
  ReplaceAiConnectionBody,
  ReplacePersonalAiConnectionBody,
  StartPersonalAiSignInResponse,
} from "../app/src/lib/api/generated/models/models.zod";

/**
 * The AI connection: one per organization, read and switched by an administrator with no restart.
 * A key goes in once and never comes back out, a bad connection is refused before anything is saved
 * with one of five stated reasons, and every example the spec shows is one the generated client
 * accepts, so a fake built from the examples matches what the server answers.
 */

type Schema = {
  $ref?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
  writeOnly?: boolean;
};
type Example = { value?: unknown; $ref?: string };
type Media = { schema: Schema; examples?: Record<string, Example> };
type Response = { $ref?: string; content?: Record<string, Media> };
type Operation = {
  operationId: string;
  tags?: string[];
  security?: Record<string, string[]>[];
  parameters?: { $ref: string }[];
  requestBody?: { content: Record<string, Media> };
  responses: Record<string, Response>;
};

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, Schema>;
    responses: Record<string, Response>;
    examples: Record<string, Example>;
  };
};

const PATH = "/api/v2/organizations/{organizationId}/ai-connection";
const item = spec.paths[PATH] ?? {};
const read = item.get;
const replace = item.put;

function response(ref: Response): Response {
  if (!ref.$ref) return ref;
  return spec.components.responses[
    ref.$ref.replace("#/components/responses/", "")
  ] as Response;
}
function exampleValue(example: Example): unknown {
  if (!example.$ref) return example.value;
  return spec.components.examples[
    example.$ref.replace("#/components/examples/", "")
  ]?.value;
}
function propertyNames(
  schema: Schema | undefined,
  seen = new Set<string>(),
): string[] {
  if (!schema) return [];
  if (schema.$ref) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    if (seen.has(name)) return [];
    seen.add(name);
    return propertyNames(spec.components.schemas[name], seen);
  }
  return [
    ...Object.entries(schema.properties ?? {}).flatMap(([name, property]) => [
      name,
      ...propertyNames(property, seen),
    ]),
    ...propertyNames(schema.items, seen),
    ...(schema.oneOf ?? []).flatMap((part) => propertyNames(part, seen)),
  ];
}

test("an administrator reads and replaces the one AI connection, a replace taking an Idempotency-Key", () => {
  expect(read?.operationId).toBe("getAiConnection");
  expect(replace?.operationId).toBe("replaceAiConnection");
  expect(read?.tags).toEqual(["Models"]);
  expect(replace?.tags).toEqual(["Models"]);
  expect(read?.security).toContainEqual({ appOAuth: ["ai-connection:read"] });
  expect(replace?.security).toContainEqual({
    appOAuth: ["ai-connection:write"],
  });
  expect(read?.responses["403"]?.$ref).toContain("AdminOnly");
  expect(replace?.responses["403"]?.$ref).toContain("AdminOnly");
  expect(replace?.parameters?.map((p) => p.$ref)).toContainEqual(
    expect.stringContaining("IdempotencyKey"),
  );
});

test("an administrator disconnects the organization's AI, with an Idempotency-Key, and never where it is fixed", () => {
  const disconnect = item.delete;
  expect(disconnect?.operationId).toBe("deleteAiConnection");
  expect(disconnect?.tags).toEqual(["Models"]);
  expect(disconnect?.security).toContainEqual({
    appOAuth: ["ai-connection:write"],
  });
  expect(disconnect?.responses["403"]?.$ref).toContain("AdminOnly");
  expect(disconnect?.responses["409"]?.$ref).toContain("AiConnectionFixed");
  expect(disconnect?.parameters?.map((p) => p.$ref)).toContainEqual(
    expect.stringContaining("IdempotencyKey"),
  );
  const answers = Object.values(
    disconnect?.responses["200"]?.content?.["application/json"]?.examples ?? {},
  ).map(exampleValue);
  expect(answers.length).toBe(1);
  for (const answer of answers) {
    const parsed = GetAiConnectionResponse.parse(answer);
    // Nothing in use afterwards, and the other keys still kept.
    expect(parsed.provider).toBeNull();
    expect(parsed.source).toBe("none");
    expect(parsed.saved.length).toBeGreaterThan(0);
  }
});

test("no answer has a place for a key, and the key sent is write-only", () => {
  for (const operation of [read, replace, item.delete]) {
    const body =
      operation?.responses["200"]?.content?.["application/json"]?.schema;
    expect(body).toBeDefined();
    const names = propertyNames(body);
    for (const secret of ["apiKey", "secret", "token", "key"]) {
      expect(names).not.toContain(secret);
    }
  }
  const input = spec.components.schemas.AiConnectionInput;
  expect(
    Object.entries(input?.properties ?? {})
      .filter(([, property]) => property.writeOnly)
      .map(([name]) => name),
  ).toEqual(["apiKey"]);
});

test("a connection OpenBot can't use is refused with one of five reasons, in OpenBot's own words", () => {
  const refused = response(replace?.responses["422"] ?? {});
  const examples = Object.values(
    refused.content?.["application/problem+json"]?.examples ?? {},
  ).map((example) => exampleValue(example) as { code: string; detail: string });
  expect(examples.map((example) => example.code).sort()).toEqual([
    "AI_CONNECTION_ENGINE_NOT_READY",
    "AI_CONNECTION_KEY_REFUSED",
    "AI_CONNECTION_MODEL_UNAVAILABLE",
    "AI_CONNECTION_SIGN_IN_MISSING",
    "AI_CONNECTION_UNREACHABLE",
  ]);
  for (const example of examples) {
    expect(example.detail).not.toContain("—");
    expect(example.detail).toMatch(/\.$/);
  }
  const fixed = response(replace?.responses["409"] ?? {});
  const codes = Object.values(
    fixed.content?.["application/problem+json"]?.examples ?? {},
  ).map((example) => (exampleValue(example) as { code: string }).code);
  expect(codes.sort()).toEqual([
    "AI_CONNECTION_FIXED",
    "IDEMPOTENCY_KEY_CONFLICT",
  ]);
});

test("every example the spec shows is one the generated client accepts", () => {
  const answers = [read, replace].flatMap((operation) =>
    Object.values(
      operation?.responses["200"]?.content?.["application/json"]?.examples ??
        {},
    ),
  );
  expect(answers.length).toBeGreaterThanOrEqual(4);
  for (const example of answers) {
    expect(
      GetAiConnectionResponse.safeParse(exampleValue(example)).success,
    ).toBe(true);
  }
  const bodies = Object.values(
    replace?.requestBody?.content["application/json"]?.examples ?? {},
  );
  expect(bodies.length).toBeGreaterThanOrEqual(4);
  for (const example of bodies) {
    expect(
      ReplaceAiConnectionBody.safeParse(exampleValue(example)).success,
    ).toBe(true);
  }
});

test("an answer may name a provider this client doesn't know, and a switch is refused one the server doesn't take", () => {
  const answer = {
    provider: "a-provider-added-later",
    login: "endpoint",
    model: "model-a",
    endpointHost: "api.example.com",
    keySet: true,
    ready: true,
    source: "stored",
    editable: true,
    saved: [
      {
        provider: "a-provider-added-later",
        login: "endpoint",
        endpointHost: "api.example.com",
      },
    ],
    changedAt: "2026-11-20T00:00:00Z",
  };
  expect(GetAiConnectionResponse.safeParse(answer).success).toBe(true);
  const body = (provider: string) =>
    ReplaceAiConnectionBody.safeParse({
      provider,
      login: "endpoint",
      baseUrl: "https://api.trustedrouter.com/v1",
      model: "anthropic/claude-sonnet-5.5",
      apiKey: "sk-example",
    }).success;
  expect(body("trustedrouter")).toBe(true);
  expect(body("unbiased")).toBe(true);
  expect(body("a-provider-added-later")).toBe(false);
  expect(body("")).toBe(false);
});

test("an endpoint address is http or https with nothing in it that signs in", () => {
  const endpoint = (baseUrl: string) =>
    ReplaceAiConnectionBody.safeParse({
      provider: "openai-compatible",
      login: "endpoint",
      baseUrl,
      model: "llama-5",
    }).success;
  expect(endpoint("https://api.example.com/v1")).toBe(true);
  expect(endpoint("http://127.0.0.1:11434/v1")).toBe(true);
  expect(endpoint("https://user:secret@api.example.com/v1")).toBe(false);
  expect(endpoint("https://key@api.example.com")).toBe(false);
  expect(endpoint("ftp://api.example.com")).toBe(false);
  expect(endpoint("file:///etc/passwd")).toBe(false);
  // Unknown fields are refused, so a key can't ride in under another name.
  expect(
    (
      spec.components.schemas.AiConnectionInput as {
        additionalProperties?: boolean;
      }
    ).additionalProperties,
  ).toBe(false);
});

const PERSONAL =
  "/api/v2/organizations/{organizationId}/people/{personId}/ai-connection";
const personal = spec.paths[PERSONAL] ?? {};
const signIns = spec.paths[`${PERSONAL}/sign-ins`] ?? {};
const signIn = spec.paths[`${PERSONAL}/sign-ins/{signInId}`] ?? {};
const signInCode = spec.paths[`${PERSONAL}/sign-ins/{signInId}/code`] ?? {};

test("a person's own AI connection is theirs alone: only they read, set, sign in to or remove it", () => {
  const operations = [
    personal.get,
    personal.put,
    personal.delete,
    signIns.post,
    signIn.get,
    signInCode.post,
  ];
  expect(operations.map((operation) => operation?.operationId)).toEqual([
    "getPersonalAiConnection",
    "replacePersonalAiConnection",
    "deletePersonalAiConnection",
    "startPersonalAiSignIn",
    "getPersonalAiSignIn",
    "finishPersonalAiSignIn",
  ]);
  for (const operation of operations) {
    expect(operation?.responses["403"]?.$ref).toContain("OwnOnly");
    const scopes = operation?.security?.flatMap(
      (scheme) => scheme.appOAuth ?? [],
    );
    expect(
      scopes?.every((scope) => scope.startsWith("personal-ai-connection:")),
    ).toBe(true);
  }
  for (const write of [
    personal.put,
    personal.delete,
    signIns.post,
    signInCode.post,
  ]) {
    expect(write?.parameters?.map((p) => p.$ref)).toContainEqual(
      expect.stringContaining("IdempotencyKey"),
    );
  }
});

test("no answer about a person's own AI has a place for a key, and every example parses", () => {
  for (const operation of [
    personal.get,
    personal.put,
    personal.delete,
    signIns.post,
    signIn.get,
    signInCode.post,
  ]) {
    const success = operation?.responses["200"] ?? operation?.responses["201"];
    const names = propertyNames(success?.content?.["application/json"]?.schema);
    for (const secret of ["apiKey", "secret", "token", "key", "deviceCode"]) {
      expect(names).not.toContain(secret);
    }
  }
  const parses = (
    operation: Operation | undefined,
    status: string,
    schema: { safeParse: (value: unknown) => { success: boolean } },
  ) => {
    const examples = Object.values(
      operation?.responses[status]?.content?.["application/json"]?.examples ??
        {},
    );
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples)
      expect(schema.safeParse(exampleValue(example)).success).toBe(true);
  };
  parses(personal.get, "200", GetPersonalAiConnectionResponse);
  parses(signIns.post, "201", StartPersonalAiSignInResponse);
  parses(signIn.get, "200", GetPersonalAiSignInResponse);
  parses(signInCode.post, "200", FinishPersonalAiSignInResponse);
  for (const example of Object.values(
    signInCode.post?.requestBody?.content["application/json"]?.examples ?? {},
  ))
    expect(
      FinishPersonalAiSignInBody.safeParse(exampleValue(example)).success,
    ).toBe(true);
  for (const example of Object.values(
    personal.put?.requestBody?.content["application/json"]?.examples ?? {},
  ))
    expect(
      ReplacePersonalAiConnectionBody.safeParse(exampleValue(example)).success,
    ).toBe(true);
});

/*
 * Several AI connections at once (plans/multiple-ai-connections-spec.md). The single connection above
 * keeps its meaning and is the default; these list, connect, remove and make default, once for the
 * organization (admins) and once for a person (themselves). All of it only grows the API.
 */
const LIST = "/api/v2/organizations/{organizationId}/ai-connections";
const PERSONAL_LIST =
  "/api/v2/organizations/{organizationId}/people/{personId}/ai-connections";
const ORG_SIGN_INS =
  "/api/v2/organizations/{organizationId}/ai-connection-sign-ins";

function operationsOf(base: string) {
  const list = spec.paths[base] ?? {};
  const one = spec.paths[`${base}/{connectionId}`] ?? {};
  const makeDefault = spec.paths[`${base}/{connectionId}/make-default`] ?? {};
  return {
    list: list.get,
    connect: list.post,
    remove: one.delete,
    makeDefault: makeDefault.post,
  };
}

test("an administrator lists, connects, removes and makes default the organization's connections", () => {
  const { list, connect, remove, makeDefault } = operationsOf(LIST);
  expect(
    [list, connect, remove, makeDefault].map((o) => o?.operationId),
  ).toEqual([
    "listAiConnections",
    "connectAiConnection",
    "removeAiConnection",
    "makeAiConnectionDefault",
  ]);
  for (const operation of [list, connect, remove, makeDefault]) {
    expect(operation?.tags).toEqual(["Models"]);
    expect(operation?.responses["403"]?.$ref).toContain("AdminOnly");
  }
  expect(list?.security).toContainEqual({ appOAuth: ["ai-connection:read"] });
  for (const write of [connect, remove, makeDefault]) {
    expect(write?.security).toContainEqual({
      appOAuth: ["ai-connection:write"],
    });
    expect(write?.parameters?.map((p) => p.$ref)).toContainEqual(
      expect.stringContaining("IdempotencyKey"),
    );
  }
  expect(list?.parameters?.map((p) => p.$ref)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Limit"),
      expect.stringContaining("Cursor"),
    ]),
  );
  expect(remove?.responses["204"]).toBeDefined();
  expect(remove?.responses["404"]?.$ref).toContain("AiConnectionNotFound");
  expect(makeDefault?.responses["404"]?.$ref).toContain("AiConnectionNotFound");
  expect(makeDefault?.responses["409"]?.$ref).toContain("AiConnectionNotReady");
  expect(connect?.responses["422"]?.$ref).toContain("AiConnectionRefused");
});

test("a person lists, connects, removes and makes default their own connections, and only they may", () => {
  const { list, connect, remove, makeDefault } = operationsOf(PERSONAL_LIST);
  expect(
    [list, connect, remove, makeDefault].map((o) => o?.operationId),
  ).toEqual([
    "listPersonalAiConnections",
    "connectPersonalAiConnection",
    "removePersonalAiConnection",
    "makePersonalAiConnectionDefault",
  ]);
  for (const operation of [list, connect, remove, makeDefault]) {
    expect(operation?.responses["403"]?.$ref).toContain("OwnOnly");
    const scopes = operation?.security?.flatMap((s) => s.appOAuth ?? []);
    expect(
      scopes?.every((scope) => scope.startsWith("personal-ai-connection:")),
    ).toBe(true);
  }
  for (const write of [connect, remove, makeDefault])
    expect(write?.parameters?.map((p) => p.$ref)).toContainEqual(
      expect.stringContaining("IdempotencyKey"),
    );
  expect(connect?.responses["409"]?.$ref).toContain(
    "PersonalAiConnectionUnavailable",
  );
});

test("the organization signs in to a provider the way a person does, with the same schemas", () => {
  const start = spec.paths[ORG_SIGN_INS]?.post;
  const read = spec.paths[`${ORG_SIGN_INS}/{signInId}`]?.get;
  const finish = spec.paths[`${ORG_SIGN_INS}/{signInId}/code`]?.post;
  expect([start, read, finish].map((o) => o?.operationId)).toEqual([
    "startAiSignIn",
    "getAiSignIn",
    "finishAiSignIn",
  ]);
  const schemaOf = (operation: Operation | undefined, status: string) =>
    operation?.responses[status]?.content?.["application/json"]?.schema?.$ref;
  expect(schemaOf(start, "201")).toBe(schemaOf(signIns.post, "201"));
  expect(schemaOf(read, "200")).toBe(schemaOf(signIn.get, "200"));
  expect(schemaOf(finish, "200")).toBe(schemaOf(signInCode.post, "200"));
  for (const operation of [start, read, finish])
    expect(operation?.responses["403"]?.$ref).toContain("AdminOnly");
});

test("no connection in a list, and no catalogue connection, has a place for a key or an address", () => {
  for (const name of ["AiConnectionEntry", "AiConnectionPage"]) {
    const names = propertyNames({ $ref: `#/components/schemas/${name}` });
    expect(names.length).toBeGreaterThan(0);
    for (const secret of ["apiKey", "baseUrl", "key", "token", "secret"])
      expect(names).not.toContain(secret);
  }
  const catalogue = propertyNames({
    $ref: "#/components/schemas/ModelCatalogueConnection",
  });
  expect(catalogue).toContain("owner");
  for (const hidden of ["apiKey", "baseUrl", "endpointHost", "key", "token"])
    expect(catalogue).not.toContain(hidden);
});

test("what an older client reads and sends is unchanged: every new field is optional", () => {
  const schemas = spec.components.schemas as Record<
    string,
    Schema & { required?: string[] }
  >;
  const required = (name: string) => schemas[name]?.required ?? [];
  expect(required("ModelCatalogue")).not.toContain("connections");
  expect(required("ModelChoice")).not.toContain("connection");
  expect(required("ModelChoice")).not.toContain("stopped");
  expect(required("ModelChoiceInput")).not.toContain("connection");
  expect(Object.keys(schemas.ModelCatalogue?.properties ?? {})).toContain(
    "connections",
  );
  expect(Object.keys(schemas.ModelChoice?.properties ?? {})).toEqual(
    expect.arrayContaining(["connection", "stopped"]),
  );
  expect(Object.keys(schemas.ModelChoiceInput?.properties ?? {})).toContain(
    "connection",
  );
});

test("every example of the connection lists parses with the generated client", async () => {
  const zod = (await import(
    "../app/src/lib/api/generated/models/models.zod"
  )) as unknown as Record<
    string,
    { safeParse: (value: unknown) => { success: boolean } }
  >;
  const parses = (
    operation: Operation | undefined,
    status: string,
    name: string,
  ) => {
    const schema = zod[name];
    expect(schema).toBeDefined();
    const examples = Object.values(
      operation?.responses[status]?.content?.["application/json"]?.examples ??
        {},
    );
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples)
      expect(schema?.safeParse(exampleValue(example)).success).toBe(true);
  };
  const org = operationsOf(LIST);
  const mine = operationsOf(PERSONAL_LIST);
  parses(org.list, "200", "ListAiConnectionsResponse");
  parses(org.connect, "201", "ConnectAiConnectionResponse");
  parses(org.makeDefault, "200", "MakeAiConnectionDefaultResponse");
  parses(mine.list, "200", "ListPersonalAiConnectionsResponse");
  const catalogue =
    spec.paths["/api/v2/organizations/{organizationId}/model-catalogue"]?.get;
  parses(catalogue, "200", "GetModelCatalogueResponse");
  const choice =
    spec.paths[
      "/api/v2/organizations/{organizationId}/people/{personId}/model-choices/{conversationId}"
    ];
  parses(choice?.get, "200", "GetModelChoiceResponse");
  const examples = Object.values(
    catalogue?.responses["200"]?.content?.["application/json"]?.examples ?? {},
  ).map(exampleValue) as { connections?: unknown[] }[];
  expect(
    examples.some((example) => (example.connections?.length ?? 0) > 1),
  ).toBe(true);
});
