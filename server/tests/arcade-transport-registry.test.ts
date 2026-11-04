import { describe, expect, test } from "bun:test";
import type { BrokerProvider } from "../src/plugins/access";
import * as arcade from "../src/plugins/arcade";
import type {
  CuratedTransportKind,
  TransportKind,
} from "../src/plugins/transport";
import { transportFor } from "../src/plugins/transport";

/*
 * The type half is checked by `tsc`, not bun: this file is named in `server/tsconfig.json`'s
 * `include` (the store-provider-required precedent), because a `@ts-expect-error` under the
 * unchecked `server/tests` would assert nothing. Run `bun run typecheck`.
 */
// @ts-expect-error a catalogue entry must not name the arcade broker's transport
const _arcadeIsNotCurated: CuratedTransportKind = "arcade";
// @ts-expect-error nor the composio broker's
const _composioIsNotCurated: CuratedTransportKind = "composio";
const _arcadeIsAKind: TransportKind = "arcade";
// BrokerProvider is the compiler's claim about TransportKind, not a comment's.
const _brokerIsAKind: TransportKind = "arcade" satisfies BrokerProvider;

describe("arcade transport registration", () => {
  test("transportFor('arcade') is the arcade module and needs no credential", () => {
    const t = transportFor("arcade");
    expect(t).toBe(arcade as unknown as typeof t);
    expect(t.listNeedsCredential).toBe(false);
  });
});
