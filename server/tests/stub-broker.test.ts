// server/tests/stub-broker.test.ts
/**
 * Contract test for `support/stub-broker.ts`: an unprovided member fails loudly, a swallowed reach
 * is still caught, a provided member is used and recorded, and the declarations cannot be skipped.
 */
import { expect, test } from "bun:test";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import {
  type BrokerMethod,
  stubBroker,
  unprovidedMessage,
} from "./support/stub-broker";

/** Every method of the seam, spelled out so a member the factory forgot is a test failure too. */
const METHODS: BrokerMethod[] = [
  "grantsFor",
  "authProviderOf",
  "listApps",
  "ensureAuthConfig",
  "deleteAuthConfig",
  "authorize",
  "isConnected",
  "revoke",
  "connectionFields",
  "connectWithFields",
  "revokeAccount",
  "accountName",
];

const account = {
  holder: "person",
  userId: "u_1",
  vendorUserId: "v_1",
} as const;

test("every method the test did not provide throws, and records that it was reached", () => {
  const stub = stubBroker({ grantIsLocal: true, authorizations: null });
  for (const name of METHODS) {
    const member = stub.broker[name] as unknown as () => unknown;
    expect(() => member()).toThrow(unprovidedMessage(name));
  }
  expect(stub.unprovided).toEqual(METHODS);
  expect(stub.calls).toEqual([]);
});

test("the stub has exactly the seam's members, no more and no fewer", () => {
  const stub = stubBroker({ grantIsLocal: false, authorizations: null });
  expect(Object.keys(stub.broker).sort()).toEqual(
    ["grantIsLocal", "authorizations", ...METHODS].sort(),
  );
});

test("a reach that production SWALLOWS is still caught by the after-each check", async () => {
  const stub = stubBroker({ grantIsLocal: true, authorizations: null });
  // The shape round-2 C8a planted in `store.ts`: a revoke whose failure is caught and dropped.
  // A throw alone passes here; the record is what makes it a red.
  try {
    await stub.broker.revokeAccount("ca_1");
  } catch {}
  expect(() => stub.expectNothingUnprovidedReached()).toThrow();
  // The check clears the record, so one reach is reported once.
  expect(() => stub.expectNothingUnprovidedReached()).not.toThrow();
});

test("a fire-and-forget .catch cannot swallow it: the throw is synchronous", () => {
  const stub = stubBroker({ grantIsLocal: true, authorizations: null });
  expect(() => stub.broker.revokeAccount("ca_1").catch(() => {})).toThrow(
    unprovidedMessage("revokeAccount"),
  );
});

test("a provided member is the one called, and every call to it is recorded", async () => {
  const revoked: string[] = [];
  const stub = stubBroker({
    grantIsLocal: true,
    authorizations: null,
    revokeAccount: async (id) => {
      revoked.push(id);
    },
    accountName: async () => "Ada",
  });
  await stub.broker.revokeAccount("ca_1");
  expect(await stub.broker.accountName({ account, toolkit: "gmail" })).toBe(
    "Ada",
  );
  expect(revoked).toEqual(["ca_1"]);
  expect(stub.calls).toEqual([
    { member: "revokeAccount", args: ["ca_1"] },
    { member: "accountName", args: [{ account, toolkit: "gmail" }] },
  ]);
  stub.expectNothingUnprovidedReached();
});

test("the declarations are passed through as given, never defaulted", () => {
  const stub = stubBroker({ grantIsLocal: false, authorizations: null });
  expect(stub.broker.grantIsLocal).toBe(false);
  expect(stub.broker.authorizations).toBeNull();
});

/*
 * THE TYPE PINS. These fail `typecheck:tests` if the factory ever starts defaulting a declaration or
 * accepting a member of the wrong shape — and fail it the other way, on an unused directive, if the
 * error they expect goes away.
 */
// @ts-expect-error - grantIsLocal is a declaration the test must make.
const _withoutGrantIsLocal = () => stubBroker({ authorizations: null });
// @ts-expect-error - authorizations is a declaration the test must make, even when it is null.
const _withoutAuthorizations = () => stubBroker({ grantIsLocal: true });
const _wrongShape = () =>
  stubBroker({
    grantIsLocal: true,
    authorizations: null,
    // @ts-expect-error - revokeAccount answers Promise<void>, not a boolean.
    revokeAccount: () => true,
  });
const _typedAsSeam: () => ConnectedAppBroker = () =>
  stubBroker({ grantIsLocal: true, authorizations: null }).broker;
