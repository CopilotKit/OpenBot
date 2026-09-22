import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_DECLARED_SURFACES,
  parseSurfaceDeclarations,
  resolveTenantSurfaces,
} from "../src/surfaces";
import { loadTenantPackage } from "../src/tenant-package";

const examplePackage = new URL("../../examples/fintech", import.meta.url)
  .pathname;
const scratch = mkdtempSync(join(tmpdir(), "surface-declarations-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The shipped example package, with `surfaces.yaml` set to the file under test. */
function packageDeclaring(surfaces: string) {
  const copy = mkdtempSync(join(scratch, "package-"));
  cpSync(examplePackage, copy, { recursive: true });
  writeFileSync(join(copy, "surfaces.yaml"), surfaces);
  return copy;
}

describe("surface declarations", () => {
  test("reads the three keys a surface has", () => {
    expect(
      parseSurfaceDeclarations([
        {
          id: "quotes-desk",
          title: "Quotes desk",
          agent_id: "general-assistant",
        },
      ]),
    ).toEqual([
      { id: "quotes-desk", title: "Quotes desk", agentId: "general-assistant" },
    ]);
  });

  test("a package with no surfaces declares none", () => {
    expect(parseSurfaceDeclarations(undefined)).toEqual([]);
    expect(parseSurfaceDeclarations(null)).toEqual([]);
  });

  test("refuses a key a surface does not have", () => {
    expect(() =>
      parseSurfaceDeclarations([
        {
          id: "quotes-desk",
          title: "Quotes desk",
          agent_id: "general-assistant",
          token: "shared-secret",
        },
      ]),
    ).toThrow(/has key "token"/);
  });

  test("refuses a value read from the environment", () => {
    /*
     * The reference is built rather than written out: the case under test is the two characters
     * `${`, and a literal one in a test file reads to a formatter as a mistake in the test.
     */
    const reference = ["$", "{DEPLOYMENT_SECRET}"].join("");
    expect(() =>
      parseSurfaceDeclarations([
        { id: "quotes-desk", title: reference, agent_id: "general-assistant" },
      ]),
    ).toThrow(/\$\{\.\.\.\}/);
  });

  test("refuses a URL in a declaration", () => {
    expect(() =>
      parseSurfaceDeclarations([
        {
          id: "quotes-desk",
          title: "Quotes desk at https://internal.example",
          agent_id: "general-assistant",
        },
      ]),
    ).toThrow(/may not contain a URL/);
  });

  test("refuses the same id twice", () => {
    expect(() =>
      parseSurfaceDeclarations([
        {
          id: "quotes-desk",
          title: "Quotes desk",
          agent_id: "general-assistant",
        },
        {
          id: "quotes-desk",
          title: "Quotes desk (old)",
          agent_id: "general-assistant",
        },
      ]),
    ).toThrow(/declares surface id "quotes-desk" twice/);
  });

  test("refuses more surfaces than the contract reads", () => {
    const tooMany = Array.from(
      { length: MAX_DECLARED_SURFACES + 1 },
      (_, index) => ({
        id: `desk-${index}`,
        title: `Desk ${index}`,
        agent_id: "general-assistant",
      }),
    );
    expect(() => parseSurfaceDeclarations(tooMany)).toThrow(/more than the 8/);
  });
});

describe("surface resolution", () => {
  const declared = [
    { id: "quotes-desk", title: "Quotes desk", agentId: "general-assistant" },
  ];

  test("answers with the path the build mounts", () => {
    expect(
      resolveTenantSurfaces(declared, [
        { id: "quotes-desk", path: "/api/quotes" },
      ]),
    ).toEqual([
      {
        id: "quotes-desk",
        title: "Quotes desk",
        agentId: "general-assistant",
        path: "/api/quotes",
      },
    ]);
  });

  test("refuses a declaration this build does not serve", () => {
    expect(() =>
      resolveTenantSurfaces(declared, [
        { id: "claims-desk", path: "/api/claims" },
      ]),
    ).toThrow(/does not serve; this build serves claims-desk/);
  });
});

describe("a package that declares a surface", () => {
  test("loads it, and a package with no surfaces.yaml declares none", async () => {
    expect((await loadTenantPackage(examplePackage)).surfaces).toEqual([]);
    const declared = await loadTenantPackage(
      packageDeclaring(
        [
          "surfaces:",
          "  - id: quotes-desk",
          "    title: Quotes desk",
          "    agent_id: general-assistant",
          "",
        ].join("\n"),
      ),
    );
    expect(declared.surfaces).toEqual([
      { id: "quotes-desk", title: "Quotes desk", agentId: "general-assistant" },
    ]);
  });

  test("refuses a surface naming a coworker the package does not have", async () => {
    await expect(
      loadTenantPackage(
        packageDeclaring(
          [
            "surfaces:",
            "  - id: quotes-desk",
            "    title: Quotes desk",
            "    agent_id: somebody-not-here",
            "",
          ].join("\n"),
        ),
      ),
    ).rejects.toThrow(
      /names agent "somebody-not-here", which this package does not declare/,
    );
  });

  test("refuses a file that is malformed rather than dropping it", async () => {
    await expect(
      loadTenantPackage(packageDeclaring("surfaces:\n  - id: Quotes Desk\n")),
    ).rejects.toThrow(/surfaces.yaml/);
  });
});
