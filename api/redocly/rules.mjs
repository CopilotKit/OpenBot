/**
 * OpenBot's API conventions, as Redocly lint rules.
 *
 * OpenBot's API reads as one API with CopilotKit Intelligence's v2 API, so it keeps Intelligence's
 * conventions: OpenAPI 3.1, every resource under the organization address, RFC 9457 problem details
 * for every error, cursor and limit paging for every list, and an Idempotency-Key on every write. Each
 * rule below fails `redocly lint` when the spec drifts from one of them, so a pull request finds out
 * before a client or the server is built on the drift.
 *
 * Registered in redocly.yaml as the `openbot` plugin.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const ORGANIZATION_PREFIX = "/api/v2/organizations/{organizationId}/";
const WRITE_METHODS = ["post", "put", "patch", "delete"];
const METHODS = ["get", "head", "options", "trace", ...WRITE_METHODS];
const PROBLEM_JSON = "application/problem+json";
const PROBLEM_SCHEMA = "#/components/schemas/Problem";

const reserved = parse(
  readFileSync(
    new URL("../intelligence-reserved.yaml", import.meta.url),
    "utf8",
  ),
);

/** Where Intelligence already answers this path, or null when it is OpenBot's to take. */
export function intelligenceOwner(path) {
  if (reserved.exact.includes(path)) return path;
  const root = /^\/api\/v2\/([^/]+)/.exec(path)?.[1];
  if (root && reserved.roots.includes(root)) return `/api/v2/${root}`;
  if (!path.startsWith(ORGANIZATION_PREFIX)) return null;
  const noun = path.slice(ORGANIZATION_PREFIX.length).split("/")[0];
  if (reserved.organization.names.includes(noun)) return noun;
  const prefix = reserved.organization.prefixes.find((start) =>
    noun.startsWith(start),
  );
  return prefix ? `${prefix}*` : null;
}

/** Fails on any path that names a resource Intelligence's v2 API already serves. */
function NoIntelligenceCollision() {
  return {
    Paths: {
      enter(paths, ctx) {
        for (const path of Object.keys(paths)) {
          const owner = intelligenceOwner(path);
          if (!owner) continue;
          ctx.report({
            message: `${path} collides with Intelligence's ${owner}. OpenBot's paths sit beside Intelligence's under one address, so a name Intelligence serves is never OpenBot's (api/intelligence-reserved.yaml).`,
            location: ctx.location.child([path]).key(),
          });
        }
      },
    },
  };
}

/** Every path is under the organization address, in kebab-case, with camelCase parameters. */
function OrganizationScoped() {
  return {
    Paths: {
      enter(paths, ctx) {
        for (const path of Object.keys(paths)) {
          const location = ctx.location.child([path]).key();
          if (!path.startsWith(ORGANIZATION_PREFIX)) {
            ctx.report({
              message: `${path} is not under ${ORGANIZATION_PREFIX}. Every OpenBot resource belongs to an organization, as every Intelligence v2 resource does.`,
              location,
            });
            continue;
          }
          for (const segment of path.slice(1).split("/")) {
            const parameter = /^\{(.+)\}$/.exec(segment)?.[1];
            const ok = parameter
              ? /^[a-z][a-zA-Z0-9]*$/.test(parameter)
              : /^[a-z0-9]+(-[a-z0-9]+)*$/.test(segment);
            if (!ok) {
              ctx.report({
                message: `${path}: "${segment}" should be ${parameter ? "a camelCase parameter, like {botId}" : "lower-case kebab-case, like api-keys"}.`,
                location,
              });
            }
          }
        }
      },
    },
  };
}

function resolved(ctx, node) {
  return node && typeof node === "object" ? ctx.resolve(node).node : node;
}

function operationsOf(pathItem) {
  return METHODS.filter((method) => pathItem[method]).map((method) => [
    method,
    pathItem[method],
  ]);
}

/** Every error response is application/problem+json, and nothing else, with the shared Problem schema. */
function ProblemDetailsErrors() {
  return {
    PathItem: {
      enter(pathItem, ctx) {
        for (const [method, operation] of operationsOf(pathItem)) {
          for (const [status, raw] of Object.entries(
            operation.responses ?? {},
          )) {
            if (!/^[45]/.test(status) && status !== "default") continue;
            const response = resolved(ctx, raw);
            const content = response?.content ?? {};
            const types = Object.keys(content);
            const schema = content[PROBLEM_JSON]?.schema;
            if (
              types.length !== 1 ||
              types[0] !== PROBLEM_JSON ||
              schema?.$ref !== PROBLEM_SCHEMA
            ) {
              ctx.report({
                message: `${method.toUpperCase()} ${status} must be ${PROBLEM_JSON} only, with the schema ${PROBLEM_SCHEMA} (RFC 9457, as Intelligence's v2 API).`,
                location: ctx.location.child([method, "responses", status]),
              });
            }
          }
        }
      },
    },
  };
}

/** Every write takes a required Idempotency-Key header. */
function IdempotencyKeyOnWrites() {
  return {
    PathItem: {
      enter(pathItem, ctx) {
        const shared = pathItem.parameters ?? [];
        for (const [method, operation] of operationsOf(pathItem)) {
          if (!WRITE_METHODS.includes(method)) continue;
          const parameters = [...shared, ...(operation.parameters ?? [])].map(
            (parameter) => resolved(ctx, parameter),
          );
          const key = parameters.find(
            (parameter) =>
              parameter?.in === "header" &&
              String(parameter.name).toLowerCase() === "idempotency-key",
          );
          if (key?.required !== true) {
            ctx.report({
              message: `${method.toUpperCase()} is a write, so it takes a required Idempotency-Key header ($ref: '#/components/parameters/IdempotencyKey').`,
              location: ctx.location.child([method]),
            });
          }
        }
      },
    },
  };
}

/**
 * Every list pages with `cursor` and `limit` and answers `nextCursor`.
 *
 * A GET on a path that ends in a name rather than a parameter is a list, unless it says it is one
 * thing with `x-openbot-singleton: true`.
 */
function CursorPaging() {
  return {
    Paths: {
      enter(paths, ctx) {
        for (const [path, rawItem] of Object.entries(paths)) {
          const pathItem = resolved(ctx, rawItem);
          const operation = pathItem?.get;
          if (
            !operation ||
            /\}$/.test(path) ||
            operation["x-openbot-singleton"]
          )
            continue;
          const parameters = [
            ...(pathItem.parameters ?? []),
            ...(operation.parameters ?? []),
          ].map((parameter) => resolved(ctx, parameter));
          const query = new Set(
            parameters
              .filter((parameter) => parameter?.in === "query")
              .map((parameter) => parameter.name),
          );
          const ok = resolved(ctx, operation.responses?.["200"]);
          const schema = resolved(
            ctx,
            ok?.content?.["application/json"]?.schema,
          );
          const missing = [
            ...(query.has("cursor") ? [] : ["the cursor parameter"]),
            ...(query.has("limit") ? [] : ["the limit parameter"]),
            ...(schema?.properties?.nextCursor
              ? []
              : ["nextCursor in its 200 response"]),
          ];
          if (missing.length === 0) continue;
          ctx.report({
            message: `GET ${path} is a list, so it needs ${missing.join(", ")} (cursor paging, as Intelligence's v2 API). Mark a single resource x-openbot-singleton: true.`,
            location: ctx.location.child([path, "get"]),
          });
        }
      },
    },
  };
}

/** The document is OpenAPI 3.1, which every tool in the chain was checked against. */
function OpenApi31() {
  return {
    Root: {
      enter(root, ctx) {
        if (/^3\.1\.\d+$/.test(String(root.openapi))) return;
        ctx.report({
          message: `openapi is ${root.openapi}. OpenBot's API is OpenAPI 3.1, like Intelligence's.`,
          location: ctx.location.child(["openapi"]),
        });
      },
    },
  };
}

export default function openbotRules() {
  return {
    id: "openbot",
    rules: {
      oas3: {
        "no-intelligence-collision": NoIntelligenceCollision,
        "organization-scoped": OrganizationScoped,
        "problem-details-errors": ProblemDetailsErrors,
        "idempotency-key-on-writes": IdempotencyKeyOnWrites,
        "cursor-paging": CursorPaging,
        "openapi-3-1": OpenApi31,
      },
    },
  };
}
