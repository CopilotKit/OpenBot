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

  test("still refuses pool options where the address belongs", () => {
    // @ts-expect-error the wrong-way-round call this guard exists for
    expect(() => createDatabase({ max: 1 })).toThrow(/connection string/);
  });
});
