import { afterEach, describe, expect, test } from "bun:test";
import { createDatabase } from "../src/db/client";

/**
 * The address goes to Bun in parts, and `$DATABASE_URL` does not survive the call.
 *
 * Both halves matter and only together. Bun reads a connection URL's path as the path of a unix
 * socket, so `postgres://…/openbot` cannot connect on Windows (oven-sh/bun#27713); and it prefers
 * `$DATABASE_URL` to the options it was handed, so passing the parts while the variable is still
 * set changes nothing. These assert the observable half: what the environment looks like
 * afterwards, and which addresses are refused before a socket is ever opened.
 */
const original = process.env.DATABASE_URL;

afterEach(() => {
  if (original === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = original;
});

describe("the database address", () => {
  test("is taken out of the environment, so Bun cannot prefer it to the parts", () => {
    process.env.DATABASE_URL =
      "postgres://openbot:openbot@127.0.0.1:5432/openbot";

    createDatabase("postgres://openbot:openbot@127.0.0.1:5432/openbot");

    expect(process.env.DATABASE_URL).toBeUndefined();
  });

  test("refuses a connection string that is not a URL, naming what it got", () => {
    expect(() => createDatabase("://openbot@/openbot")).toThrow(
      /DATABASE_URL is not a URL/,
    );
  });

  test("refuses a URL with no host, which would otherwise parse and connect nowhere", () => {
    // `new URL` accepts this: the scheme is "openbot:" and there is no host at all.
    expect(() => createDatabase("openbot:openbot@localhost/openbot")).toThrow(
      /names no host/,
    );
  });

  test("refuses a URL that names no database, rather than connecting to a default", () => {
    expect(() =>
      createDatabase("postgres://openbot:openbot@127.0.0.1:5432"),
    ).toThrow(/names no database/);
  });

  test("refuses a password holding a percent that starts no escape, naming the part", () => {
    /*
     * `new URL` accepts this and `decodeURIComponent` does not, so the refusal used to be a bare
     * `URIError: URI error` naming neither DATABASE_URL nor the password -- out of the one function
     * whose job is to make a connection failure legible. A generated password is a common place to
     * find a literal `%`.
     */
    expect(() =>
      createDatabase("postgres://openbot:100%pure@127.0.0.1:5432/openbot"),
    ).toThrow(/DATABASE_URL has a password that is not percent-encoded/);
  });

  test("refuses a username holding one too", () => {
    expect(() =>
      createDatabase("postgres://open%bot:openbot@127.0.0.1:5432/openbot"),
    ).toThrow(/DATABASE_URL has a username that is not percent-encoded/);
  });

  test("refuses a database name holding one too", () => {
    expect(() =>
      createDatabase("postgres://openbot:openbot@127.0.0.1:5432/open%bot"),
    ).toThrow(/DATABASE_URL has a database name that is not percent-encoded/);
  });

  test("still accepts a password that IS percent-encoded, decoding it", () => {
    // The escape a correctly written password uses: `%40` is `@`, which cannot be written raw.
    expect(() =>
      createDatabase("postgres://openbot:p%40ss@127.0.0.1:5432/openbot"),
    ).not.toThrow();
  });

  test("still refuses pool options where the address belongs", () => {
    // @ts-expect-error the wrong-way-round call this guard exists for
    expect(() => createDatabase({ max: 1 })).toThrow(/connection string/);
  });
});

describe("connection parameters on the URL", () => {
  test("survive, because a dropped application_name turns a lock test into a timeout", async () => {
    const named = createDatabase(
      "postgres://openbot:openbot@127.0.0.1:5432/openbot?application_name=db_client_address_probe",
    );

    const rows = await named.execute(
      "select application_name from pg_stat_activity where pid = pg_backend_pid()",
    );

    expect(
      (rows as Array<{ application_name: string }>)[0]?.application_name,
    ).toBe("db_client_address_probe");
  });
});
