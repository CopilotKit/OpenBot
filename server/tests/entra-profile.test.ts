import { describe, expect, test } from "bun:test";
import { mapEntraProfile } from "../src/auth";

/**
 * Finding an address for somebody arriving from Entra.
 *
 * Entra does not always send `email`: Microsoft return it only when the profile carries an email
 * attribute, and a multi-tenant application may receive no optional claims at all, because an
 * external user's token is minted by their own tenant. `common`, the default tenant here, is
 * multi-tenant.
 *
 * It matters more here than in most products because every authorization decision OpenBot makes
 * about a person is keyed on their address, so an absent one is not cosmetic: they would sign in,
 * match no administrator, and land as a plain user with nothing explaining why.
 */
describe("mapEntraProfile", () => {
  test("uses the email claim when it is there", () => {
    expect(
      mapEntraProfile({ email: "someone@acme.com", upn: "other@acme.com" }),
    ).toEqual({ email: "someone@acme.com" });
  });

  test("falls back to the directory's own name for the account", () => {
    expect(mapEntraProfile({ upn: "someone@acme.com" })).toEqual({
      email: "someone@acme.com",
    });
  });

  test("falls back again to preferred_username", () => {
    expect(mapEntraProfile({ preferred_username: "someone@acme.com" })).toEqual(
      { email: "someone@acme.com" },
    );
  });

  /*
   * `preferred_username` is explicitly not promised to be an address by the OIDC spec: it may be a
   * phone number or a bare username. Something without an @ is not an address and must not be
   * written into a column every authorization rule reads.
   */
  test("ignores a preferred_username that is not an address", () => {
    expect(mapEntraProfile({ preferred_username: "someone" })).toEqual({});
  });

  // Nothing, so Better Auth refuses the sign-in. Being refused is a better answer than being
  // quietly admitted as somebody the deployment cannot recognise.
  test("finds nothing rather than inventing something", () => {
    expect(mapEntraProfile({ oid: "abc", name: "A Person" })).toEqual({});
  });
});
