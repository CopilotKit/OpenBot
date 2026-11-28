import { expect, test } from "bun:test";
import {
  heldOut,
  LINK_COMPANY_ACCOUNT,
  linkButtons,
} from "../mobile/src/company-sign-in";
import { homeView } from "../mobile/src/home-view";
import { IN_NO_ORGANIZATION } from "../mobile/src/organization";

// A member an organization holds out until they sign in through their company (Require SSO), on the phone: Home showed
// the server's sentence as an error, with no way to do the company sign-in it asked for.

test("held out of the organization they work in, Home is the held view; linked, or not required, it is the app", () => {
  expect(homeView(true, undefined, { required: true, met: false })).toBe(
    "held-out",
  );
  expect(homeView(true, undefined, { required: true, met: true })).toBe(
    "working",
  );
  expect(homeView(true, undefined, { required: false, met: false })).toBe(
    "working",
  );
  // Not read yet: the app, as before.
  expect(homeView(true, undefined)).toBe("working");
  // In no organization, and signed out, come first.
  expect(
    homeView(true, IN_NO_ORGANIZATION, { required: true, met: false }),
  ).toBe("in-no-organization");
  expect(homeView(false, undefined, { required: true, met: false })).toBe(
    "signed-out",
  );
  expect(heldOut(undefined)).toBe(false);
});

test("one provider is Link your company account; several are one button each, by the domain each signs in", () => {
  expect(linkButtons([{ id: "acme-okta", domain: "acme.com" }])).toEqual([
    { providerId: "acme-okta", title: LINK_COMPANY_ACCOUNT },
  ]);
  expect(
    linkButtons([
      { id: "acme-okta", domain: "acme.com" },
      { id: "anchor-entra", domain: "anchorlaw.com" },
    ]),
  ).toEqual([
    { providerId: "acme-okta", title: "Link through acme.com" },
    { providerId: "anchor-entra", title: "Link through anchorlaw.com" },
  ]);
  expect(linkButtons([])).toEqual([]);
});
