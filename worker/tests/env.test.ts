import { describe, expect, test } from "bun:test";
import { loadWorkerEnv, routineRunUrl } from "../src/env";

const base = () => ({
  WORKER_SHARED_SECRET: "secret",
  SERVER_INTERNAL_URL: "http://server:3001",
  DATABASE_URL: "postgres://localhost:5432/openbot",
  HOSTNAME: "laptop",
});

describe("worker env", () => {
  test("parses a complete environment", () => {
    expect(loadWorkerEnv(base())).toEqual({
      workerSharedSecret: "secret",
      serverInternalUrl: "http://server:3001",
      databaseUrl: "postgres://localhost:5432/openbot",
      owner: "routines/laptop",
    });
  });

  test.each(["WORKER_SHARED_SECRET", "SERVER_INTERNAL_URL", "DATABASE_URL"])(
    "refuses an unset %s",
    (name) => {
      const env = base();
      delete env[name as keyof typeof env];
      expect(() => loadWorkerEnv(env)).toThrow("is not set");
    },
  );

  test.each(["WORKER_SHARED_SECRET", "SERVER_INTERNAL_URL", "DATABASE_URL"])(
    "refuses a whitespace-only %s like an unset one",
    (name) => {
      expect(() => loadWorkerEnv({ ...base(), [name]: "   " })).toThrow(
        "is not set",
      );
    },
  );

  test("trims padded values", () => {
    const env = loadWorkerEnv({
      ...base(),
      WORKER_SHARED_SECRET: "  secret  ",
      DATABASE_URL: "  postgres://localhost:5432/openbot  ",
    });
    expect(env.workerSharedSecret).toBe("secret");
    expect(env.databaseUrl).toBe("postgres://localhost:5432/openbot");
  });

  test.each([
    ["http://server:3001/", "http://server:3001"],
    ["http://server:3001///", "http://server:3001"],
  ])("strips trailing slashes from %p", (raw, normalised) => {
    expect(
      loadWorkerEnv({ ...base(), SERVER_INTERNAL_URL: raw }).serverInternalUrl,
    ).toBe(normalised);
  });

  test("refuses a URL that is only slashes", () => {
    expect(() =>
      loadWorkerEnv({ ...base(), SERVER_INTERNAL_URL: "///" }),
    ).toThrow("is not set");
  });

  test("falls back to a generated id without a hostname", () => {
    const without = base();
    delete without.HOSTNAME;
    expect(loadWorkerEnv(without, () => "abc123").owner).toBe(
      "routines/abc123",
    );
  });

  test.each(["", "   "])(
    "falls back to a generated id for HOSTNAME=%p",
    (hostname) => {
      expect(
        loadWorkerEnv({ ...base(), HOSTNAME: hostname }, () => "abc123").owner,
      ).toBe("routines/abc123");
    },
  );

  test("trims the hostname", () => {
    expect(
      loadWorkerEnv({ ...base(), HOSTNAME: "  laptop  " }).owner,
    ).toBe("routines/laptop");
  });
});

describe("routineRunUrl", () => {
  test("joins the run path onto the base URL", () => {
    expect(routineRunUrl("http://server:3001")).toBe(
      "http://server:3001/internal/routines/run",
    );
  });

  test("a trailing-slash base normalises to a single-slash run URL", () => {
    const env = loadWorkerEnv({
      ...base(),
      SERVER_INTERNAL_URL: "http://server:3001/",
    });
    expect(routineRunUrl(env.serverInternalUrl)).toBe(
      "http://server:3001/internal/routines/run",
    );
  });
});
