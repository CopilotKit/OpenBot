// server/tests/support/stub-broker.ts
/**
 * A `ConnectedAppBroker` test double whose every member the test did not provide FAILS LOUDLY.
 *
 * WHY THIS EXISTS. Broker stubs drifted from the seam in two ways, and the type checker saw
 * neither:
 *
 *   - CAST PAST THE TYPE. `{ … } as unknown as ConnectedAppBroker` or `{} as ConnectedAppBroker`
 *     makes a stub that omits `revoke` and `revokeAccount` compile. The compiler's guarantee is
 *     gone exactly as it was when a broken `import type` degraded the type to `any` (round-2 C8).
 *     Use this factory instead so missing methods remain type errors.
 *   - A PLAUSIBLE DEFAULT. `revokeAccount: async () => {}` type-checks and answers "done" for a
 *     revoke that never happened. A test can then pass on a fiction, and the revoke seam is the
 *     one this PR's Claim 2 is about.
 *
 * So the factory takes the members a test actually means, and everything else becomes a member
 * that RECORDS that it was reached and THROWS. This hoists round-2 C8a's `unasked` pattern into one
 * place: a throw alone is only as loud as the path that receives it — a `catch` in production
 * swallows it and the test passes — which is why each reach is also recorded, and
 * {@link BrokerStub.expectNothingUnprovidedReached} (run it in an `afterEach`) reads the record.
 *
 * WHAT THE SIGNATURE FORCES.
 *
 *   - `grantIsLocal` and `authorizations` are REQUIRED. They are declarations, not behaviour; the
 *     seam makes a broker SAY them (see `ConnectedAppBroker.authorizations`), and a factory that
 *     defaulted them would reintroduce the plausible-default defect one field along.
 *   - Every method is optional, and an omitted one throws. There is no default that returns a
 *     value, on purpose: a test that needs `revokeAccount` to succeed writes that, in its own file,
 *     where a reviewer reads it.
 *   - The result is built as a `ConnectedAppBroker` OBJECT LITERAL with no cast, so adding a member
 *     to the seam fails `typecheck:tests` here until the factory learns it, instead of every stub
 *     in the suite silently lacking it.
 *
 * Every call to a PROVIDED member is recorded too, in {@link BrokerStub.calls}, so an honest stub
 * that wants to assert "revokeAccount was asked for ca_1" does not have to hand-roll a recorder.
 */
import { expect } from "bun:test";
import type { ConnectedAppBroker } from "../../src/plugins/broker";

/** The members a broker DECLARES rather than does. Required: there is no honest default. */
type Declared = "grantIsLocal" | "authorizations";

/** What a test hands {@link stubBroker}: the declarations, plus whichever methods it means. */
export type StubBrokerInput = Pick<ConnectedAppBroker, Declared> &
  Partial<Omit<ConnectedAppBroker, Declared>>;

/** The name of a broker method, i.e. every member that is not a declaration. */
export type BrokerMethod = Exclude<keyof ConnectedAppBroker, Declared>;

export type BrokerStub = {
  /** The double itself, typed as the seam with no cast. */
  broker: ConnectedAppBroker;
  /** Every call to a member the test PROVIDED, in order. */
  calls: Array<{ member: BrokerMethod; args: unknown[] }>;
  /** Every call to a member the test did NOT provide, in order — each of which also threw. */
  unprovided: BrokerMethod[];
  /** Asserts no unprovided member was reached since the last check, and clears the record. */
  expectNothingUnprovidedReached(): void;
};

/** The sentence an unprovided member throws, exported so a test can match it exactly. */
export function unprovidedMessage(member: BrokerMethod): string {
  return `stubBroker: production reached broker.${member}, which this test did not provide`;
}

export function stubBroker(input: StubBrokerInput): BrokerStub {
  const calls: BrokerStub["calls"] = [];
  const unprovided: BrokerMethod[] = [];

  /**
   * The provided member, recorded; or, when absent, a member that records and throws.
   *
   * The throw is SYNCHRONOUS. Every broker method returns a promise, so an `await` sees it the
   * same as a rejection, while a fire-and-forget `.catch(() => {})` cannot swallow it.
   */
  function member<F extends (...args: never[]) => unknown>(
    name: BrokerMethod,
    provided: F | undefined,
  ): ((...args: Parameters<F>) => ReturnType<F>) | (() => never) {
    if (provided === undefined) {
      return () => {
        unprovided.push(name);
        throw new Error(unprovidedMessage(name));
      };
    }
    return (...args: Parameters<F>) => {
      calls.push({ member: name, args });
      return provided(...args) as ReturnType<F>;
    };
  }

  const broker: ConnectedAppBroker = {
    grantIsLocal: input.grantIsLocal,
    authorizations: input.authorizations,
    grantsFor: member("grantsFor", input.grantsFor),
    authProviderOf: member("authProviderOf", input.authProviderOf),
    listApps: member("listApps", input.listApps),
    ensureAuthConfig: member("ensureAuthConfig", input.ensureAuthConfig),
    deleteAuthConfig: member("deleteAuthConfig", input.deleteAuthConfig),
    authorize: member("authorize", input.authorize),
    isConnected: member("isConnected", input.isConnected),
    revoke: member("revoke", input.revoke),
    connectionFields: member("connectionFields", input.connectionFields),
    connectWithFields: member("connectWithFields", input.connectWithFields),
    revokeAccount: member("revokeAccount", input.revokeAccount),
    accountName: member("accountName", input.accountName),
  };

  return {
    broker,
    calls,
    unprovided,
    expectNothingUnprovidedReached() {
      expect(unprovided.splice(0)).toEqual([]);
    },
  };
}
