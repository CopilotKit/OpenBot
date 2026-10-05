import { describe, expect, test } from "bun:test";
import { emailDomainAllowed } from "../src/auth/email-domain";

// Why this exists at all, and what it cannot do, is in `server/src/auth/email-domain.ts`.
describe("whether an address may sign in", () => {
  test("an empty list admits everybody, so an upgrade locks nobody out", () => {
    expect(emailDomainAllowed("anyone@anywhere.test", [])).toBe(true);
    expect(emailDomainAllowed(null, [])).toBe(true);
  });

  test("a named domain admits its own and refuses the rest", () => {
    expect(emailDomainAllowed("a@example.com", ["example.com"])).toBe(true);
    expect(emailDomainAllowed("a@other.test", ["example.com"])).toBe(false);
  });

  test("both sides are reduced to one spelling before they are compared", () => {
    // The list as somebody writes it: quoted with an @, shouted, with a root dot.
    expect(emailDomainAllowed("a@example.com", ["@Example.COM."])).toBe(true);
    expect(emailDomainAllowed("A@EXAMPLE.COM.", ["example.com"])).toBe(true);
    // An IDN matches whichever way either side spells it, because both go through IDNA.
    expect(emailDomainAllowed("a@exämple.com", ["xn--exmple-cua.com"])).toBe(
      true,
    );
    expect(emailDomainAllowed("a@xn--exmple-cua.com", ["exämple.com"])).toBe(
      true,
    );
  });

  /**
   * The reason this is an exact match and not a suffix one.
   *
   * Every address below ends with the allowed domain as a string and none of them is at it. A
   * suffix check admits all four, which is the usual way a host rule fails.
   */
  test("does not admit a lookalike that merely ends with the domain", () => {
    for (const email of [
      "a@evil-example.com",
      "a@notexample.com",
      "a@example.com.attacker.test",
      "a@sub.example.com",
    ]) {
      expect(emailDomainAllowed(email, ["example.com"])).toBe(false);
    }
  });

  test("a quoted local part may carry an @, and an unquoted one may not", () => {
    // `"a@b"@example.com` is a legal address at example.com, so the last @ is the separator.
    expect(emailDomainAllowed('"a@b"@example.com', ["example.com"])).toBe(true);
    // `x@evil.test@example.com` is not an address at all. Reading it as the last @ says would
    // admit an attacker-chosen local part to a deployment that named example.com.
    expect(
      emailDomainAllowed("attacker@evil.test@example.com", ["example.com"]),
    ).toBe(false);
  });

  test("refuses an address it cannot read, once a list exists", () => {
    for (const value of [null, undefined, "", "person", "person@", "@x.test"]) {
      expect(emailDomainAllowed(value, ["example.com"])).toBe(false);
    }
  });

  test("an entry that names no domain matches nothing", () => {
    // config.ts refuses this at start-up rather than shipping it; belt and braces here.
    expect(emailDomainAllowed("a@example.com", [""])).toBe(false);
  });
});
