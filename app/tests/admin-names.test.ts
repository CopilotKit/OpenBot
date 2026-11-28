import { expect, test } from "bun:test";
import {
  sentTo,
  withAdmins,
  yourAdmins,
} from "@/lib/organizations/admin-names";

/**
 * How a member is told who the admins are: a few named, owners first as the list arrives, and the
 * rest counted; anybody without a name by their address. name-the-admins.test.tsx holds where it is
 * said.
 */

const priya = { name: "Priya Raman", email: "priya@northwind.test" };
const ines = { name: "Ines Duarte", email: "ines@northwind.test" };
const morgan = { name: "Morgan Reyes", email: "morgan@northwind.test" };
const tom = { name: "Tom Avery", email: "tom@northwind.test" };
const kit = { name: null, email: "kit@northwind.test" };
const ONLY = "Only an admin can give it.";

test("one, two, three, and more than three", () => {
  expect(withAdmins(ONLY, [priya])).toBe(
    "Only an admin can give it: Priya Raman (priya@northwind.test).",
  );
  expect(withAdmins(ONLY, [priya, ines])).toBe(
    "Only an admin can give it: Priya Raman (priya@northwind.test) or Ines Duarte (ines@northwind.test).",
  );
  expect(withAdmins(ONLY, [priya, ines, kit])).toBe(
    "Only an admin can give it: Priya Raman (priya@northwind.test), Ines Duarte (ines@northwind.test) or kit@northwind.test.",
  );
  expect(withAdmins(ONLY, [priya, ines, morgan, tom, kit])).toBe(
    "Only an admin can give it: Priya Raman (priya@northwind.test), Ines Duarte (ines@northwind.test), Morgan Reyes (morgan@northwind.test) and 2 more.",
  );
});

test("with nobody to name, the sentence is as it was", () => {
  expect(withAdmins(ONLY, [])).toBe(ONLY);
  expect(withAdmins(ONLY, [{ name: "  ", email: "" }])).toBe(ONLY);
  expect(sentTo([])).toBe("");
  expect(yourAdmins([])).toBe("");
});

test("who a request went to, by name, or address where there is no name", () => {
  expect(sentTo([priya])).toBe("Sent to Priya Raman.");
  expect(sentTo([priya, kit])).toBe(
    "Sent to Priya Raman and kit@northwind.test.",
  );
  expect(sentTo([priya, ines, morgan])).toBe(
    "Sent to Priya Raman, Ines Duarte and Morgan Reyes.",
  );
  expect(sentTo([priya, ines, morgan, tom])).toBe(
    "Sent to Priya Raman, Ines Duarte, Morgan Reyes and 1 more.",
  );
});

test("beside a refusal the server wrote", () => {
  expect(yourAdmins([priya])).toBe(
    "Your admin is Priya Raman (priya@northwind.test).",
  );
  expect(yourAdmins([priya, kit])).toBe(
    "Your admins are Priya Raman (priya@northwind.test) and kit@northwind.test.",
  );
});
