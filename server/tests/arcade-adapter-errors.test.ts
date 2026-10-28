import { describe, expect, test } from "bun:test";
import { APIConnectionError, APIError } from "@arcadeai/arcadejs";
import { normalizeArcadeError } from "../src/plugins/arcade-adapter";

// The SDK's real shape: constructor(status, error, message, headers); own fields status,
// headers, error. Nothing on it names the tool.
const refusal = () =>
  new APIError(
    403,
    { name: "tool_authorization_required", message: "Authorize Gmail first" },
    undefined,
    new Headers(),
  );

describe("normalizeArcadeError", () => {
  test("a realistically-shaped 403 normalizes", () => {
    expect(normalizeArcadeError(refusal())).toEqual({
      status: 403,
      name: "tool_authorization_required",
      message: "Authorize Gmail first",
    });
  });

  test("the same error wrapped in cause still normalizes", () => {
    const wrapped = new Error("outer", {
      cause: new Error("middle", { cause: refusal() }),
    });
    expect(normalizeArcadeError(wrapped)).toEqual({
      status: 403,
      name: "tool_authorization_required",
      message: "Authorize Gmail first",
    });
  });

  test("a plain Error answers null", () => {
    expect(normalizeArcadeError(new Error("boom"))).toBeNull();
  });

  test("non-errors answer null", () => {
    expect(normalizeArcadeError(undefined)).toBeNull();
    expect(normalizeArcadeError("403")).toBeNull();
  });

  test("a cyclic cause chain terminates with null", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    a.cause = a;
    expect(normalizeArcadeError(a)).toBeNull();
  });

  test("an error with no body leaves name and message undefined", () => {
    expect(
      normalizeArcadeError(
        new APIError(500, undefined, undefined, new Headers()),
      ),
    ).toEqual({
      status: 500,
      name: undefined,
      message: undefined,
    });
  });

  test("a connection failure keeps status undefined", () => {
    expect(
      normalizeArcadeError(new APIConnectionError({ message: "down" }))?.status,
    ).toBeUndefined();
  });
});
