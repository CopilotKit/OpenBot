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
    const { owner, ...rest } = loadWorkerEnv(base());
    expect(rest).toEqual({
      workerSharedSecret: "secret",
      serverInternalUrl: "http://server:3001",
      databaseUrl: "postgres://localhost:5432/openbot",
      tickMs: 30_000,
      purgeEveryNTicks: 120,
      purgeOlderThanMs: 24 * 60 * 60 * 1000,
      dispatchRetries: 3,
      dispatchTimeoutMs: 30_000,
      dispatchRetryBaseMs: 500,
    });
    expect(owner).toMatch(/^routines\/laptop-[0-9a-f]{8}$/);
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

  test("names itself without a hostname, and never as the bare role", () => {
    const without = base();
    delete without.HOSTNAME;
    expect(loadWorkerEnv(without).owner).toMatch(/^routines\/[0-9a-f]{8}$/);
  });

  test.each(["", "   "])("does not read HOSTNAME=%p as a name", (hostname) => {
    const owner = loadWorkerEnv({ ...base(), HOSTNAME: hostname }).owner;
    expect(owner).not.toBe("routines/");
    expect(owner).toMatch(/^routines\/[0-9a-f]{8}$/);
  });

  test("trims the hostname", () => {
    expect(loadWorkerEnv({ ...base(), HOSTNAME: "  laptop  " }).owner).toMatch(
      /^routines\/laptop-[0-9a-f]{8}$/,
    );
  });

  test("two workers on one host never share an owner", () => {
    expect(loadWorkerEnv(base()).owner).not.toBe(loadWorkerEnv(base()).owner);
  });

  test.each([
    ["WORKER_TICK_MS", "tickMs", "30000", 30_000],
    ["WORKER_PURGE_EVERY_N_TICKS", "purgeEveryNTicks", "60", 60],
    ["WORKER_PURGE_OLDER_THAN_MS", "purgeOlderThanMs", "3600000", 3_600_000],
    ["WORKER_DISPATCH_RETRIES", "dispatchRetries", "5", 5],
    ["WORKER_DISPATCH_TIMEOUT_MS", "dispatchTimeoutMs", "10000", 10_000],
    ["WORKER_DISPATCH_RETRY_BASE_MS", "dispatchRetryBaseMs", "1000", 1000],
  ])("reads %s as %s", (name, field, raw, expected) => {
    const env = loadWorkerEnv({ ...base(), [name]: raw });
    expect(env[field as keyof typeof env]).toBe(expected);
  });

  test.each([
    "WORKER_TICK_MS",
    "WORKER_PURGE_EVERY_N_TICKS",
    "WORKER_PURGE_OLDER_THAN_MS",
    "WORKER_DISPATCH_RETRIES",
    "WORKER_DISPATCH_TIMEOUT_MS",
    "WORKER_DISPATCH_RETRY_BASE_MS",
  ])("treats a blank %s as unset", (name) => {
    const env = loadWorkerEnv({ ...base(), [name]: "   " });
    const defaults = loadWorkerEnv(base());
    expect(env[nameToField(name) as keyof typeof env]).toBe(
      defaults[nameToField(name) as keyof typeof defaults],
    );
  });

  test.each([
    ["WORKER_TICK_MS", "30s"],
    ["WORKER_TICK_MS", "12abc"],
    ["WORKER_TICK_MS", "3.9"],
    ["WORKER_TICK_MS", "-5000"],
    ["WORKER_PURGE_EVERY_N_TICKS", "hourly"],
    ["WORKER_DISPATCH_RETRIES", "many"],
    ["WORKER_DISPATCH_TIMEOUT_MS", "30s"],
  ])("refuses a non-numeric %s=%p", (name, raw) => {
    expect(() => loadWorkerEnv({ ...base(), [name]: raw as string })).toThrow(
      name,
    );
  });

  test.each([
    ["WORKER_TICK_MS", "10"],
    ["WORKER_TICK_MS", "3600001"],
    ["WORKER_PURGE_EVERY_N_TICKS", "0"],
    ["WORKER_PURGE_OLDER_THAN_MS", "1000"],
    ["WORKER_DISPATCH_RETRIES", "11"],
    ["WORKER_DISPATCH_RETRIES", "-1"],
    ["WORKER_DISPATCH_TIMEOUT_MS", "10"],
    ["WORKER_DISPATCH_RETRY_BASE_MS", "1"],
  ])("refuses an out-of-range %s=%p", (name, raw) => {
    expect(() => loadWorkerEnv({ ...base(), [name]: raw as string })).toThrow(
      name,
    );
  });

  test("allows zero dispatch retries to switch the retry off", () => {
    expect(
      loadWorkerEnv({ ...base(), WORKER_DISPATCH_RETRIES: "0" })
        .dispatchRetries,
    ).toBe(0);
  });
});

function nameToField(name: string): string {
  if (name === "WORKER_TICK_MS") return "tickMs";
  if (name === "WORKER_PURGE_EVERY_N_TICKS") return "purgeEveryNTicks";
  if (name === "WORKER_PURGE_OLDER_THAN_MS") return "purgeOlderThanMs";
  if (name === "WORKER_DISPATCH_RETRIES") return "dispatchRetries";
  if (name === "WORKER_DISPATCH_TIMEOUT_MS") return "dispatchTimeoutMs";
  return "dispatchRetryBaseMs";
}

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
