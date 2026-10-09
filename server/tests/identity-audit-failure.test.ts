import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { logLinkAuditFailure } from "../src/identity/audit-failure";

let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  spy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => spy.mockRestore());

function logged(error: unknown): Record<string, unknown> {
  logLinkAuditFailure("github", error);
  return JSON.parse(spy.mock.calls[0][0] as string);
}

function pgError(errno: string, message = "boom user-123"): Error {
  const error = new Error(message);
  error.name = "PostgresError";
  Object.assign(error, { errno, code: "ERR_POSTGRES_SERVER_ERROR" });
  return error;
}

test("reports the SQLSTATE of a Postgres error", () => {
  expect(logged(pgError("57014"))).toEqual({
    type: "identity-link-audit-failed",
    provider: "github",
    errorName: "PostgresError",
    errorCode: "57014",
  });
});

test("reports the SQLSTATE of a Postgres error wrapped as a cause", () => {
  const wrapper = new Error("Failed query: insert ... params: user-123", {
    cause: pgError("23505"),
  });
  expect(logged(wrapper).errorCode).toBe("23505");
});

test("does not report system error codes as a SQLSTATE", () => {
  for (const code of ["EPIPE", "EPERM", "ECONNRESET"]) {
    spy.mockClear();
    const error = Object.assign(new Error("sys"), { code, errno: code });
    expect(logged(error)).not.toHaveProperty("errorCode");
    spy.mockClear();
    expect(logged(new Error("w", { cause: error }))).not.toHaveProperty(
      "errorCode",
    );
  }
});

test("omits errorCode when there is none", () => {
  expect(logged(new Error("x"))).not.toHaveProperty("errorCode");
});

test("handles non-Error thrown values", () => {
  for (const value of ["str", null, undefined, 42, { errno: "23505" }]) {
    spy.mockClear();
    const out = logged(value);
    expect(out.errorName).toBe("unknown");
    expect(out).not.toHaveProperty("errorCode");
  }
});

test("never logs the message or ids", () => {
  logLinkAuditFailure("slack", pgError("23505", "secret user-123"));
  expect(spy.mock.calls[0][0] as string).not.toContain("user-123");
});
