import { describe, expect, test } from "bun:test";
import { asHostAccessDesktopResult } from "../src/host-access/schema";

describe("host access schema", () => {
  test("folder grant results keep only the opaque id and display name", () => {
    expect(
      asHostAccessDesktopResult({
        operationId: "operation-1",
        ok: true,
        grant: {
          grantId: "grant-1",
          displayName: "Project",
          writable: true,
        },
      }),
    ).toEqual({
      operationId: "operation-1",
      ok: true,
      grant: {
        grantId: "grant-1",
        displayName: "Project",
      },
    });
  });
});
