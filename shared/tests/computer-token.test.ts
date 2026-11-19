/**
 * Each computer's own token, per organization.
 *
 * The values for `default` were taken from the derivation before organizations were named in it: a
 * computer already running in `default` must keep its token, or it is treated as stale and replaced.
 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  COMPUTER_TOKEN_LABEL,
  computerTokenFor,
  computerTokenSubject,
} from "../computer-token";

const DEPLOYMENT = "deployment-token";

describe("a computer's own token", () => {
  test("in default, and with no organization, is exactly the token it was before", () => {
    const person = "3eed5a997a504f19f0daf0d625977086fa9de6e7a0790924b6fa36a3810757b6";
    const browser = "7718aa69701fa22a1ee6c725ab7c9ee95ceabf11925075e0c204ed22d9116153";
    expect(computerTokenFor(DEPLOYMENT, { kind: "person", id: "ada" })).toBe(
      person,
    );
    expect(
      computerTokenFor(DEPLOYMENT, {
        kind: "person",
        id: "ada",
        organizationId: "default",
      }),
    ).toBe(person);
    expect(
      computerTokenFor(DEPLOYMENT, {
        kind: "bot",
        id: "person-0a1b",
        organizationId: "default",
      }),
    ).toBe(browser);
  });

  test("outside default names the organization, so one person's computers in two organizations take two tokens", () => {
    const inAcme = computerTokenFor(DEPLOYMENT, {
      kind: "person",
      id: "ada",
      organizationId: "acme",
    });
    const inGlobex = computerTokenFor(DEPLOYMENT, {
      kind: "person",
      id: "ada",
      organizationId: "globex",
    });
    const inDefault = computerTokenFor(DEPLOYMENT, {
      kind: "person",
      id: "ada",
    });
    expect(new Set([inAcme, inGlobex, inDefault]).size).toBe(3);
    expect(inAcme).toBe(
      createHmac("sha256", DEPLOYMENT)
        .update(`${COMPUTER_TOKEN_LABEL}\norg/acme/person:ada`)
        .digest("hex"),
    );
  });

  test("an organization id with a slash or colon can't make one computer's label read as another's", () => {
    expect(
      computerTokenSubject({
        kind: "person",
        id: "ada",
        organizationId: "a/person:b",
      }),
    ).toBe("org/a%2Fperson%3Ab/person:ada");
    expect(
      computerTokenFor(DEPLOYMENT, {
        kind: "person",
        id: "b/person:ada",
        organizationId: "a",
      }),
    ).not.toBe(
      computerTokenFor(DEPLOYMENT, {
        kind: "person",
        id: "ada",
        organizationId: "a/person:b",
      }),
    );
  });
});
