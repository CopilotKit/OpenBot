import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * Every answer the API describes says it carries `X-Request-Id`.
 *
 * The server stamps it on every answer under /api, and it is the id the server's logs file the
 * request under: a problem's `requestId` is the same id. OpenBot's apps quote it when they record a
 * failure (OpenBot Desktop's troubleshooting logs do), so the request can be found in the server's
 * logs. An operation added without it would be one whose failures a client can't point at, so every
 * response, an operation's own or a shared one, declares the header.
 */

type Node = Record<string, unknown>;
type Spec = {
  paths: Record<string, Record<string, Node>>;
  components: {
    headers: Record<string, Node>;
    responses: Record<string, Node>;
  };
};

const spec = parse(
  readFileSync(join(import.meta.dir, "openapi.yaml"), "utf8"),
) as Spec;
const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

function deref(node: unknown): Node | undefined {
  let current = node as Node | undefined;
  for (let hops = 0; current && typeof current.$ref === "string"; hops++) {
    if (hops > 20) throw new Error(`A $ref loop at ${String(current.$ref)}`);
    const path = (current.$ref as string).replace(/^#\//, "").split("/");
    current = path.reduce<unknown>(
      (at, part) => (at as Record<string, unknown> | undefined)?.[part],
      spec,
    ) as Node | undefined;
  }
  return current;
}

test("the shared header is the request id the logs and a problem use", () => {
  const header = spec.components.headers.RequestId ?? {};
  expect((header.schema as Node | undefined)?.type).toBe("string");
  expect(String(header.example)).toMatch(/^req_/);
  const problem = (
    spec.components as unknown as Record<string, Record<string, Node>>
  ).schemas?.Problem as Node;
  expect((problem.required as string[]).includes("requestId")).toBe(true);
});

test("every response of every operation declares X-Request-Id", () => {
  const missing: string[] = [];
  let responses = 0;
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const operation = item[method] as Node | undefined;
      if (!operation) continue;
      for (const [status, raw] of Object.entries(
        (operation.responses as Record<string, unknown>) ?? {},
      )) {
        responses += 1;
        const response = deref(raw);
        const headers = (response?.headers as Record<string, unknown>) ?? {};
        const declared = deref(headers["X-Request-Id"]);
        if (declared !== spec.components.headers.RequestId)
          missing.push(`${method.toUpperCase()} ${path} ${status}`);
      }
    }
  }
  expect(responses).toBeGreaterThan(600);
  expect(missing).toEqual([]);
});
