/**
 * What the API spec marks deprecated, and what a server says on every answer that used one.
 *
 * The spec is the one place a deprecation is written (api/README.md, "Deprecating"): `deprecated:
 * true` on an operation, a query or header parameter, or a property of a request or response body,
 * with `x-deprecation-date` (the day it was deprecated) and `x-sunset` (the day it may go, the
 * extension oasdiff reads), both as `YYYY-MM-DD`. From those marks:
 *
 * - {@link deprecationsIn} reads the table of every deprecated element. The server is generated a copy
 *   of it, so it never writes a deprecation header by hand.
 * - {@link deprecatedOperation} and {@link usedBy} find which elements a request used, and
 *   {@link deprecationHeaders} the three headers its answer carries: `Deprecation` (RFC 9745),
 *   `Sunset` (RFC 8594) and `Link` with `rel="deprecation"`, pointing at the changelog that says what
 *   replaces it.
 * - {@link countedClients} names who used it, from the `OpenBot-Client` header, for the count a
 *   removal waits on: nothing is removed before its sunset, nor while anything still uses it.
 * - {@link missingFromChangelog} holds the changelog to the spec: every deprecated element is listed,
 *   with its sunset, under a release's "Before upgrading".
 *
 * A response property is in the table and the changelog like anything else, but no request uses it,
 * so no answer is marked for it and nothing counts it: a server can't see which fields a client
 * reads. Its removal waits on its sunset alone.
 */

/** Where the `Link` header points: the changelog, whose Deprecated list says what replaces each one. */
export const DEPRECATION_LINK =
  "https://github.com/CopilotKit/OpenBot/blob/main/CHANGELOG.md";

/** Where in an operation a deprecated element is. */
export type DeprecatedPlace =
  | { in: "operation" }
  | { in: "query" | "header"; name: string }
  | { in: "body" | "response"; property: string[] };

/** One deprecated element, as the spec marks it. */
export type DeprecatedElement = {
  /**
   * How the changelog names it and its uses are counted: the operation (`GET /api/v2/...`), then for
   * a part of it `query <name>`, `header <name>`, `body <property>` or `response <property>`, where a
   * property is its path with `[]` for an array's items (`rules[].type`).
   */
  key: string;
  place: DeprecatedPlace;
  /** `x-deprecation-date`, `YYYY-MM-DD`. */
  deprecatedOn: string;
  /** `x-sunset`, `YYYY-MM-DD`. */
  sunset: string;
};

/** An operation that is deprecated or has a deprecated part, and the addresses that could be mistaken for it. */
export type DeprecatedOperation = {
  method: string;
  path: string;
  /**
   * The spec's other paths for the same method that one address could match as well as `path`,
   * such as `/bots/test-connection` beside `/bots/{botId}`. An address that matches one of them more
   * closely is that operation's, not this one's.
   */
  overlaps: string[];
  elements: DeprecatedElement[];
};

export type DeprecationTable = { operations: DeprecatedOperation[] };

const METHODS = ["get", "put", "post", "patch", "delete"] as const;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The day `YYYY-MM-DD` names, at midnight UTC, or undefined when it names none. */
function day(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const match = DATE.exec(value);
  if (!match) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  // `2026-02-30` parses to March: only a day that reads back the same is one.
  return date.toISOString().slice(0, 10) === value ? date : undefined;
}

/**
 * Every deprecated element in a bundled spec (api/openapi.yaml, parsed). Throws, naming every one,
 * when a mark is incomplete: no date, a date that isn't one, a sunset before the deprecation, or a
 * path parameter marked (deprecate the operation instead).
 */
export function deprecationsIn(spec: unknown): DeprecationTable {
  if (!isNode(spec) || !isNode(spec.paths))
    throw new Error("Not an OpenAPI document: it has no paths.");
  const paths = spec.paths;
  const problems: string[] = [];

  const resolve = (node: unknown): Node | undefined => {
    let current = node;
    for (
      let hops = 0;
      isNode(current) && typeof current.$ref === "string";
      hops++
    ) {
      if (hops > 32 || !current.$ref.startsWith("#/")) return undefined;
      let target: unknown = spec;
      for (const part of current.$ref.slice(2).split("/"))
        target = isNode(target)
          ? target[part.replace(/~1/g, "/").replace(/~0/g, "~")]
          : undefined;
      current = target;
    }
    return isNode(current) ? current : undefined;
  };

  /** The mark's dates, read from the node itself, then from what it refers to. */
  const element = (
    key: string,
    place: DeprecatedPlace,
    nodes: (Node | undefined)[],
  ): DeprecatedElement | undefined => {
    const read = (name: string) =>
      nodes.map((node) => node?.[name]).find((value) => value !== undefined);
    const deprecatedOn = read("x-deprecation-date");
    const sunset = read("x-sunset");
    const on = day(deprecatedOn);
    const off = day(sunset);
    if (!on)
      problems.push(
        `${key} is deprecated with no x-deprecation-date (YYYY-MM-DD): give the day it was deprecated.`,
      );
    if (!off)
      problems.push(
        `${key} is deprecated with no x-sunset (YYYY-MM-DD): give the earliest day it may be removed.`,
      );
    if (on && off && off < on)
      problems.push(
        `${key} has its x-sunset ${sunset} before its x-deprecation-date ${deprecatedOn}.`,
      );
    if (!on || !off) return undefined;
    return {
      key,
      place,
      deprecatedOn: deprecatedOn as string,
      sunset: sunset as string,
    };
  };

  /** Every deprecated property under `schema`, by its path. */
  const properties = (
    schema: unknown,
    at: string[],
    seen: Set<unknown>,
    found: (path: string[], nodes: (Node | undefined)[]) => void,
  ) => {
    const node = isNode(schema) ? schema : undefined;
    const resolved = resolve(schema);
    if (!resolved || seen.has(resolved)) return;
    const inside = new Set(seen).add(resolved);
    if (
      at.length > 0 &&
      (node?.deprecated === true || resolved.deprecated === true)
    )
      found(at, [node, resolved]);
    for (const combinator of ["allOf", "oneOf", "anyOf"]) {
      const branches = resolved[combinator];
      if (Array.isArray(branches))
        for (const branch of branches) properties(branch, at, inside, found);
    }
    if (isNode(resolved.properties))
      for (const [name, property] of Object.entries(resolved.properties))
        properties(property, [...at, name], inside, found);
    if (resolved.items !== undefined)
      properties(
        resolved.items,
        [...at.slice(0, -1), `${at.at(-1) ?? ""}[]`],
        inside,
        found,
      );
  };

  const jsonSchemas = (holder: unknown): unknown[] => {
    const content = resolve(holder)?.content;
    if (!isNode(content)) return [];
    return Object.entries(content)
      .filter(([type]) => type === "application/json" || type.endsWith("+json"))
      .map(([, media]) => (isNode(media) ? media.schema : undefined))
      .filter((schema) => schema !== undefined);
  };

  const operations: DeprecatedOperation[] = [];
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = resolve(rawItem);
    if (!item) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!isNode(operation)) continue;
      const name = `${method.toUpperCase()} ${path}`;
      const elements = new Map<string, DeprecatedElement>();
      const add = (found: DeprecatedElement | undefined) => {
        if (found && !elements.has(found.key)) elements.set(found.key, found);
      };

      if (operation.deprecated === true)
        add(element(name, { in: "operation" }, [operation]));

      const parameters = [
        ...(Array.isArray(item.parameters) ? item.parameters : []),
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ];
      for (const raw of parameters) {
        const parameter = resolve(raw);
        if (!parameter) continue;
        const schema = resolve(parameter.schema);
        if (parameter.deprecated !== true && schema?.deprecated !== true)
          continue;
        const where = parameter.in;
        const parameterName = String(parameter.name);
        if (where === "query" || where === "header")
          add(
            element(
              `${name} ${where} ${parameterName}`,
              { in: where, name: parameterName },
              [isNode(raw) ? raw : undefined, parameter, schema],
            ),
          );
        else
          problems.push(
            `${name} marks its ${String(where)} parameter ${parameterName} deprecated: only a query or header parameter can be. Deprecate the operation instead.`,
          );
      }

      for (const schema of jsonSchemas(operation.requestBody))
        properties(schema, [], new Set(), (property, nodes) =>
          add(
            element(
              `${name} body ${property.join(".")}`,
              { in: "body", property },
              nodes,
            ),
          ),
        );

      if (isNode(operation.responses))
        for (const [status, response] of Object.entries(operation.responses)) {
          if (!status.startsWith("2")) continue;
          for (const schema of jsonSchemas(response))
            properties(schema, [], new Set(), (property, nodes) =>
              add(
                element(
                  `${name} response ${property.join(".")}`,
                  { in: "response", property },
                  nodes,
                ),
              ),
            );
        }

      if (elements.size > 0)
        operations.push({
          method: method.toUpperCase(),
          path,
          overlaps: [],
          elements: [...elements.values()],
        });
    }
  }

  if (problems.length > 0) throw new Error(problems.join("\n"));

  for (const operation of operations) {
    const own = segments(operation.path);
    operation.overlaps = Object.entries(paths)
      .filter(
        ([path, rawItem]) =>
          path !== operation.path &&
          isNode(resolve(rawItem)?.[operation.method.toLowerCase()]) &&
          couldMatchSame(own, segments(path)),
      )
      .map(([path]) => path);
  }
  return { operations };
}

function segments(path: string): string[] {
  return path.split("/").slice(1);
}

const isParameter = (segment: string) => /^\{[^}]+\}$/.test(segment);

/** Whether one address could match both templates. */
function couldMatchSame(a: string[], b: string[]): boolean {
  return (
    a.length === b.length &&
    a.every((segment, index) => {
      const other = b[index] as string;
      return segment === other || isParameter(segment) || isParameter(other);
    })
  );
}

/** Whether an address's segments match a template's. */
function matches(template: string[], address: string[]): boolean {
  return (
    template.length === address.length &&
    template.every(
      (segment, index) =>
        (isParameter(segment) && (address[index] as string).length > 0) ||
        segment === address[index],
    )
  );
}

/**
 * Which of two templates an address that matches both belongs to: the one with a fixed segment where
 * the other has a parameter, first from the left, as a router tries its fixed routes first.
 */
function closer(a: string[], b: string[]): string[] {
  for (let index = 0; index < a.length; index++) {
    const left = isParameter(a[index] as string);
    const right = isParameter(b[index] as string);
    if (left !== right) return left ? b : a;
  }
  return a;
}

/**
 * The deprecated operation a request is for, when it is one: by its method and its address's path
 * (`/api/v2/organizations/default/bots/ada`, as sent, without the query).
 */
export function deprecatedOperation(
  table: DeprecationTable,
  method: string,
  path: string,
): DeprecatedOperation | undefined {
  const wanted = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const address = segments(path);
  return table.operations.find((operation) => {
    if (operation.method !== wanted) return false;
    const own = segments(operation.path);
    if (!matches(own, address)) return false;
    return operation.overlaps.every((other) => {
      const theirs = segments(other);
      return !matches(theirs, address) || closer(own, theirs) === own;
    });
  });
}

/** What a request sent, as far as a deprecation is concerned. */
export type SentRequest = {
  query: URLSearchParams;
  headers: Headers;
  /** The JSON body, parsed, when the operation has a deprecated body property. */
  body?: unknown;
};

/** Whether the operation has a deprecated body property, so its request's body must be read. */
export function readsBody(operation: DeprecatedOperation): boolean {
  return operation.elements.some((element) => element.place.in === "body");
}

function present(value: unknown, path: readonly string[]): boolean {
  const [first, ...rest] = path;
  if (first === undefined) return true;
  const list = first.endsWith("[]");
  const name = list ? first.slice(0, -2) : first;
  let inner: unknown = value;
  if (name !== "") {
    if (
      !isNode(value) ||
      !Object.hasOwn(value, name) ||
      value[name] === undefined
    )
      return false;
    inner = value[name];
  }
  if (!list) return present(inner, rest);
  return Array.isArray(inner) && inner.some((item) => present(item, rest));
}

/** The deprecated elements of `operation` a request used. */
export function usedBy(
  operation: DeprecatedOperation,
  request: SentRequest,
): DeprecatedElement[] {
  return operation.elements.filter((element) => {
    const place = element.place;
    switch (place.in) {
      case "operation":
        return true;
      case "query":
        return request.query.has(place.name);
      case "header":
        return request.headers.has(place.name);
      case "body":
        return present(request.body, place.property);
      default:
        // A response property: no request uses one.
        return false;
    }
  });
}

/**
 * The headers an answer carries when its request used `elements`: the earliest deprecation and the
 * earliest sunset among them, and where to read what replaces them. Empty for none.
 */
export function deprecationHeaders(
  elements: readonly DeprecatedElement[],
): Record<string, string> {
  if (elements.length === 0) return {};
  const earliest = (dates: string[]) => dates.sort()[0] as string;
  const deprecated = day(
    earliest(elements.map((element) => element.deprecatedOn)),
  ) as Date;
  const sunset = day(
    earliest(elements.map((element) => element.sunset)),
  ) as Date;
  return {
    // A Structured Field Date: `@` and seconds since the epoch (RFC 9745, section 2.1).
    deprecation: `@${Math.floor(deprecated.getTime() / 1000)}`,
    // An HTTP-date (RFC 8594, section 3; RFC 9110, section 5.6.7).
    sunset: sunset.toUTCString(),
    link: `<${DEPRECATION_LINK}>; rel="deprecation"; type="text/html"`,
  };
}

/** The OpenBot apps that name themselves in the `OpenBot-Client` header. */
export const CLIENT_KINDS = ["web", "desktop", "mobile", "recorder"] as const;

const VERSION = /^v?\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?$/;

/**
 * Who a use of a deprecated element is counted against, from the `OpenBot-Client` header: each
 * OpenBot app it names (`web/1.1.0 desktop/1.1.0` is OpenBot Desktop's window: both), `unknown` with
 * no header, and `other` for a header that names no OpenBot app, such as a program's own name. A
 * version that is not a release number is left out, so nothing a caller writes grows the count's
 * rows past the apps and their releases.
 */
export function countedClients(
  header: string | null | undefined,
): { kind: string; version: string }[] {
  if (!header?.trim()) return [{ kind: "unknown", version: "" }];
  const named = new Map<string, { kind: string; version: string }>();
  for (const token of header.trim().split(/\s+/).slice(0, 8)) {
    const slash = token.indexOf("/");
    if (slash < 1) continue;
    const kind = token.slice(0, slash).toLowerCase();
    if (!(CLIENT_KINDS as readonly string[]).includes(kind)) continue;
    const written = token.slice(slash + 1);
    const version = VERSION.test(written) ? written.replace(/^v/, "") : "";
    named.set(`${kind}/${version}`, { kind, version });
  }
  return named.size > 0
    ? [...named.values()]
    : [{ kind: "other", version: "" }];
}

/**
 * The deprecated elements the changelog does not list. Each must appear on a line of CHANGELOG.md
 * that names its key in backticks and its sunset date: the Deprecated list under a release's "Before
 * upgrading".
 */
export function missingFromChangelog(
  table: DeprecationTable,
  changelog: string,
): DeprecatedElement[] {
  const lines = changelog.split("\n");
  return table.operations
    .flatMap((operation) => operation.elements)
    .filter(
      (element) =>
        !lines.some(
          (line) =>
            line.includes(`\`${element.key}\``) &&
            line.includes(element.sunset),
        ),
    );
}
