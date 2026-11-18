/**
 * The deprecations the API spec marks, read from the real spec and held against the real changelog.
 *
 * The first test is the check every pull request runs: whatever api/openapi.yaml marks deprecated is
 * complete (both dates, in order) and listed in CHANGELOG.md with its sunset. The rest mark real
 * operations of a copy of the spec deprecated, the way a builder would, and follow the marks through
 * to the request that uses one and the headers its answer carries.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  countedClients,
  DEPRECATION_LINK,
  type DeprecationTable,
  deprecatedOperation,
  deprecationHeaders,
  deprecationsIn,
  missingFromChangelog,
  readsBody,
  usedBy,
} from "../api-deprecations";

const ROOT = join(import.meta.dir, "..", "..");
const SPEC_TEXT = readFileSync(join(ROOT, "api", "openapi.yaml"), "utf8");
const CHANGELOG = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

// biome-ignore lint/suspicious/noExplicitAny: the spec is edited by path here, as a builder edits it.
const spec = (): any => parse(SPEC_TEXT);

const ROUTINE = "/api/v2/organizations/{organizationId}/routines/{routineId}";
const ROUTINES = "/api/v2/organizations/{organizationId}/routines";
const HUMAN_INPUT =
  "/api/v2/organizations/{organizationId}/computers/{botId}/human-input/{kind}";
const MARK = { "x-deprecation-date": "2026-11-17", "x-sunset": "2027-11-17" };

/** The real spec with a real operation, a query parameter, a body property and a response property deprecated. */
function marked() {
  const document = spec();
  Object.assign(document.paths[ROUTINE].patch, { deprecated: true, ...MARK });
  document.paths[ROUTINES].get.parameters.push({
    name: "view",
    in: "query",
    required: false,
    schema: { type: "string" },
    deprecated: true,
    "x-deprecation-date": "2026-12-01",
    "x-sunset": "2027-12-01",
  });
  Object.assign(
    document.components.schemas.UpdateRoutineRequest.properties.cron,
    {
      deprecated: true,
      ...MARK,
    },
  );
  Object.assign(document.components.schemas.Routine.properties.title, {
    deprecated: true,
    ...MARK,
  });
  Object.assign(document.paths[HUMAN_INPUT].post, {
    deprecated: true,
    ...MARK,
  });
  return deprecationsIn(document);
}

function keys(table: DeprecationTable) {
  return table.operations.flatMap((operation) =>
    operation.elements.map((element) => element.key),
  );
}

describe("the spec's own deprecations", () => {
  test("are complete, and the changelog lists every one with its sunset", () => {
    const table = deprecationsIn(spec());
    expect(missingFromChangelog(table, CHANGELOG)).toEqual([]);
  });
});

describe("a builder's marks", () => {
  test("are read with their dates, from the operation, the parameter and each property, wherever a schema is used", () => {
    const table = marked();
    const found = keys(table);
    expect(found).toContain(`PATCH ${ROUTINE}`);
    expect(found).toContain(`GET ${ROUTINES} query view`);
    expect(found).toContain(`PATCH ${ROUTINE} body cron`);
    // A response's routine is wherever the schema is: in one routine's answer and in a list's items.
    expect(found).toContain(`PATCH ${ROUTINE} response routine.title`);
    expect(found).toContain(`GET ${ROUTINES} response routines[].title`);
    const view = table.operations
      .flatMap((operation) => operation.elements)
      .find((element) => element.key === `GET ${ROUTINES} query view`);
    expect(view).toEqual({
      key: `GET ${ROUTINES} query view`,
      place: { in: "query", name: "view" },
      deprecatedOn: "2026-12-01",
      sunset: "2027-12-01",
    });
  });

  test("an incomplete mark is refused, naming each one", () => {
    const document = spec();
    document.paths[ROUTINE].patch.deprecated = true;
    Object.assign(
      document.components.schemas.UpdateRoutineRequest.properties.cron,
      {
        deprecated: true,
        "x-deprecation-date": "2027-06-01",
        "x-sunset": "2027-01-01",
      },
    );
    document.paths[ROUTINES].get.parameters.push({
      name: "when",
      in: "query",
      schema: { type: "string" },
      deprecated: true,
      "x-deprecation-date": "2026-02-30",
      "x-sunset": "2027-02-01",
    });
    expect(() => deprecationsIn(document)).toThrow(
      [
        `GET ${ROUTINES} query when is deprecated with no x-deprecation-date (YYYY-MM-DD): give the day it was deprecated.`,
        `PATCH ${ROUTINE} is deprecated with no x-deprecation-date (YYYY-MM-DD): give the day it was deprecated.`,
        `PATCH ${ROUTINE} is deprecated with no x-sunset (YYYY-MM-DD): give the earliest day it may be removed.`,
        `PATCH ${ROUTINE} body cron has its x-sunset 2027-01-01 before its x-deprecation-date 2027-06-01.`,
      ].join("\n"),
    );
  });

  test("a path parameter can't be deprecated on its own", () => {
    const document = spec();
    document.paths[ROUTINE].patch.parameters.push({
      name: "routineId",
      in: "path",
      required: true,
      schema: { type: "string" },
      deprecated: true,
      ...MARK,
    });
    expect(() => deprecationsIn(document)).toThrow(
      `PATCH ${ROUTINE} marks its path parameter routineId deprecated: only a query or header parameter can be. Deprecate the operation instead.`,
    );
  });

  test("the changelog must list each with its sunset", () => {
    const table = marked();
    expect(
      missingFromChangelog(table, CHANGELOG).map((element) => element.key),
    ).toContain(`PATCH ${ROUTINE}`);
    const listed = [
      CHANGELOG,
      ...keys(table).map((key) =>
        key.includes("query view")
          ? `  - \`${key}\`: no longer read. Sunset 2027-12-01.`
          : `  - \`${key}\`: use something else. Sunset 2027-11-17.`,
      ),
    ].join("\n");
    expect(missingFromChangelog(table, listed)).toEqual([]);
    // The right key with the wrong date is not listed.
    const wrongDate = listed.replace(
      `\`PATCH ${ROUTINE}\`: use something else. Sunset 2027-11-17.`,
      `\`PATCH ${ROUTINE}\`: use something else. Sunset 2028-01-01.`,
    );
    expect(
      missingFromChangelog(table, wrongDate).map((element) => element.key),
    ).toEqual([`PATCH ${ROUTINE}`]);
  });
});

describe("a request", () => {
  const table = marked();

  test("finds its operation by method and address, and HEAD is GET", () => {
    const address = "/api/v2/organizations/default/routines/r_1";
    expect(deprecatedOperation(table, "PATCH", address)?.path).toBe(ROUTINE);
    expect(deprecatedOperation(table, "DELETE", address)).toBeUndefined();
    expect(
      deprecatedOperation(table, "HEAD", "/api/v2/organizations/acme/routines")
        ?.path,
    ).toBe(ROUTINES);
    expect(
      deprecatedOperation(table, "PATCH", `${address}/runs`),
    ).toBeUndefined();
    expect(
      deprecatedOperation(
        table,
        "PATCH",
        "/api/v2/organizations/default/routines/",
      ),
    ).toBeUndefined();
  });

  test("to a fixed address beside a deprecated parameter's is not the deprecated one", () => {
    const base = "/api/v2/organizations/default/computers/ada/human-input";
    expect(deprecatedOperation(table, "POST", `${base}/click`)?.path).toBe(
      HUMAN_INPUT,
    );
    expect(
      deprecatedOperation(table, "POST", `${base}/secret`),
    ).toBeUndefined();
  });

  test("uses a deprecated parameter or property only when it sends one", () => {
    const routines = deprecatedOperation(
      table,
      "GET",
      "/api/v2/organizations/default/routines",
    );
    const routine = deprecatedOperation(
      table,
      "PATCH",
      "/api/v2/organizations/default/routines/r_1",
    );
    if (!routines || !routine) throw new Error("not found");
    const sent = (query = "", body?: unknown) => ({
      query: new URLSearchParams(query),
      headers: new Headers(),
      body,
    });
    expect(
      usedBy(routines, sent("limit=10")).map((element) => element.key),
    ).toEqual([]);
    expect(
      usedBy(routines, sent("view=all")).map((element) => element.key),
    ).toEqual([`GET ${ROUTINES} query view`]);
    // The operation itself is deprecated, so every request uses it; cron only when it is sent.
    expect(readsBody(routine)).toBe(true);
    expect(
      usedBy(routine, sent("", { title: "Mail" })).map(
        (element) => element.key,
      ),
    ).toEqual([`PATCH ${ROUTINE}`]);
    expect(
      usedBy(routine, sent("", { cron: "0 9 * * *" })).map(
        (element) => element.key,
      ),
    ).toEqual([`PATCH ${ROUTINE}`, `PATCH ${ROUTINE} body cron`]);
    expect(readsBody(routines)).toBe(false);
  });

  test("answers with the RFC 9745 and RFC 8594 headers: the earliest dates among what it used", () => {
    const routines = deprecatedOperation(
      table,
      "GET",
      "/api/v2/organizations/default/routines",
    );
    if (!routines) throw new Error("not found");
    const used = usedBy(routines, {
      query: new URLSearchParams("view=1"),
      headers: new Headers(),
    });
    expect(deprecationHeaders(used)).toEqual({
      deprecation: `@${Date.UTC(2026, 11, 1) / 1000}`,
      sunset: "Wed, 01 Dec 2027 00:00:00 GMT",
      link: `<${DEPRECATION_LINK}>; rel="deprecation"; type="text/html"`,
    });
    const both = [
      ...used,
      ...(table.operations.find((operation) => operation.path === ROUTINE)
        ?.elements ?? []),
    ];
    expect(deprecationHeaders(both)).toMatchObject({
      deprecation: `@${Date.UTC(2026, 10, 17) / 1000}`,
      sunset: "Wed, 17 Nov 2027 00:00:00 GMT",
    });
    expect(deprecationHeaders([])).toEqual({});
  });
});

describe("who a use is counted against", () => {
  test.each([
    [null, [{ kind: "unknown", version: "" }]],
    ["", [{ kind: "unknown", version: "" }]],
    ["mobile/1.1.0", [{ kind: "mobile", version: "1.1.0" }]],
    [
      "web/1.1.0 desktop/v1.0.3",
      [
        { kind: "web", version: "1.1.0" },
        { kind: "desktop", version: "1.0.3" },
      ],
    ],
    ["Recorder/1.2.0-rc.1", [{ kind: "recorder", version: "1.2.0-rc.1" }]],
    ["desktop/latest", [{ kind: "desktop", version: "" }]],
    ["curl/8.7.1", [{ kind: "other", version: "" }]],
    ["my-script", [{ kind: "other", version: "" }]],
  ])("%p", (header, counted) => {
    expect(countedClients(header)).toEqual(counted);
  });
});
