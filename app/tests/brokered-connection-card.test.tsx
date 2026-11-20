import { expect, test } from "bun:test";
import { connectionKindFor } from "@/components/manage/plugin-page";
import { appBody } from "./apps-api";

/**
 * Which shape the connector page draws, decided from the row rather than guessed.
 *
 * The page used to fall back to `deployment-bearer` whenever the catalogue had nothing to say, and
 * a brokered row is exactly the case with nothing to say: it is not a curated entry, so there is no
 * `auth` to read. The guess then drew the one shape a brokered row cannot hold — a shared token
 * pasted once for everybody — over the connector whose whole point is that each person connects
 * their own account.
 *
 * `.tsx` because this imports a route module, which is JSX; see `agent-roster-error.test.tsx` for
 * the same reason. Nothing here renders: the decision is a pure function precisely so that the one
 * thing worth pinning can be pinned without a router, a query client or a document.
 */

test("an app from the directory is brokered, whatever the catalogue says", () => {
  expect(
    connectionKindFor(
      appBody({ id: "composio-gmail", title: "Gmail", provenance: "composio" }),
      undefined,
    ),
  ).toBe("brokered");
});

test("a server added by URL still falls back to the shared-token shape", () => {
  expect(
    connectionKindFor(
      appBody({ id: "wiki", title: "Wiki", provenance: "custom" }),
      undefined,
    ),
  ).toBe("deployment-bearer");
});

test("a server added by URL and marked with an Entra scope is reached as the person asking, with no token to paste", () => {
  expect(
    connectionKindFor(
      appBody({
        id: "hr",
        title: "HR",
        provenance: "custom",
        entraScope: "api://hr-api/.default",
      }),
      undefined,
    ),
  ).toBe("person-entra");
});
