import { expect, test } from "bun:test";
import { IconBrandGithub, IconBrandSlack, IconLink } from "@tabler/icons-react";
import { ClientError } from "@/lib/client";
import { alreadyUnlinked } from "@/lib/identity/mutations";
import { linkedAccountsAbsent } from "@/lib/identity/queries";
import {
  connectGithubPending,
  copyText,
  linkedAccountDescription,
  linkedAccountsSectionState,
  providerIcon,
} from "./linked-accounts";

const base = {
  id: "1",
  provider: "github" as const,
  title: "GitHub",
  createdAt: "2026-10-08T00:00:00.000Z",
};

test("an active link shows its handle", () => {
  expect(
    linkedAccountDescription({ ...base, handle: "dana", status: "active" }),
  ).toBe("@dana");
});

test("a link without a handle says it is linked", () => {
  expect(
    linkedAccountDescription({ ...base, handle: null, status: "active" }),
  ).toBe("Linked");
});

test("a link needing reconnection says so first", () => {
  expect(
    linkedAccountDescription({
      ...base,
      handle: "dana",
      status: "needs_reconnect",
    }),
  ).toBe("Needs reconnecting · @dana");
});

test("a reconnect with no handle does not also say linked", () => {
  expect(
    linkedAccountDescription({
      ...base,
      handle: null,
      status: "needs_reconnect",
    }),
  ).toBe("Needs reconnecting");
});

test("providers map to their own icon with a neutral fallback", () => {
  expect(providerIcon("slack")).toBe(IconBrandSlack);
  expect(providerIcon("github")).toBe(IconBrandGithub);
  expect(providerIcon("gitlab")).toBe(IconLink);
});

test("Object prototype keys are unknown providers, not icons", () => {
  for (const key of [
    "constructor",
    "toString",
    "hasOwnProperty",
    "__proto__",
  ]) {
    expect(providerIcon(key)).toBe(IconLink);
  }
});

test("the API's own 503 means the feature is absent, so no links", () => {
  expect(
    linkedAccountsAbsent(
      new ClientError(
        "Linked accounts are not available.",
        503,
        "LINKED_ACCOUNTS_UNAVAILABLE",
      ),
    ),
  ).toBe(true);
});

test("any other 503 is an outage, shown rather than hidden", () => {
  expect(
    linkedAccountsAbsent(new ClientError("Service Unavailable", 503)),
  ).toBe(false);
  expect(
    linkedAccountsAbsent(
      new ClientError("Unavailable", 503, "SERVICE_UNAVAILABLE"),
    ),
  ).toBe(false);
  expect(linkedAccountsAbsent(new Error("boom"))).toBe(false);
});

const row = { ...base, handle: "dana", status: "active" as const };
const slackRow = {
  ...base,
  id: "2",
  provider: "slack" as const,
  title: "Slack",
  handle: null,
  status: "active" as const,
};
const none = { slack: false, github: false };

test("the section hides when nothing is linked and nothing can be", () => {
  for (const providers of [undefined, none]) {
    expect(
      linkedAccountsSectionState({ data: [], error: null, providers }),
    ).toBe(null);
    expect(
      linkedAccountsSectionState({ data: undefined, error: null, providers }),
    ).toBe(null);
  }
});

test("each account type that can be linked gets its own card to connect from", () => {
  expect(
    linkedAccountsSectionState({
      data: [],
      error: null,
      providers: { slack: true, github: true },
    }),
  ).toEqual({
    entries: [
      { kind: "available", provider: "slack", title: "Slack" },
      { kind: "available", provider: "github", title: "GitHub" },
    ],
    error: null,
    providersError: null,
  });
  expect(
    linkedAccountsSectionState({
      data: [],
      error: null,
      providers: { slack: false, github: true },
    }),
  ).toEqual({
    entries: [{ kind: "available", provider: "github", title: "GitHub" }],
    error: null,
    providersError: null,
  });
});

test("a linked account takes the place of its connect card", () => {
  expect(
    linkedAccountsSectionState({
      data: [row],
      error: null,
      providers: { slack: true, github: true },
    }),
  ).toEqual({
    entries: [
      { kind: "available", provider: "slack", title: "Slack" },
      { kind: "linked", account: row },
    ],
    error: null,
    providersError: null,
  });
});

test("links stay listed, in Slack then GitHub order, even when linking is off", () => {
  expect(
    linkedAccountsSectionState({
      data: [row, slackRow],
      error: null,
      providers: none,
    }),
  ).toEqual({
    entries: [
      { kind: "linked", account: slackRow },
      { kind: "linked", account: row },
    ],
    error: null,
    providersError: null,
  });
});

test("a failed refetch keeps stale rows on screen and shows the error with them", () => {
  expect(
    linkedAccountsSectionState({
      data: [row],
      error: new Error("boom"),
      providers: none,
    }),
  ).toEqual({
    entries: [{ kind: "linked", account: row }],
    error: "boom",
    providersError: null,
  });
});

test("an error with no data, or with an empty cached list, still shows", () => {
  for (const data of [undefined, []]) {
    expect(
      linkedAccountsSectionState({
        data,
        error: new Error("boom"),
        providers: none,
      }),
    ).toEqual({ entries: [], error: "boom", providersError: null });
  }
});

test("a providers failure keeps the section on screen even with no links", () => {
  for (const data of [undefined, []]) {
    expect(
      linkedAccountsSectionState({
        data,
        error: null,
        providers: undefined,
        providersError: new Error("providers down"),
      }),
    ).toEqual({ entries: [], error: null, providersError: "providers down" });
  }
});

test("a providers failure keeps existing links and reports beside them", () => {
  expect(
    linkedAccountsSectionState({
      data: [row],
      error: null,
      providers: undefined,
      providersError: new Error("providers down"),
    }),
  ).toEqual({
    entries: [{ kind: "linked", account: row }],
    error: null,
    providersError: "providers down",
  });
});

test("no providers failure leaves the providers error empty", () => {
  expect(
    linkedAccountsSectionState({
      data: [row],
      error: null,
      providers: none,
      providersError: null,
    }),
  ).toEqual({
    entries: [{ kind: "linked", account: row }],
    error: null,
    providersError: null,
  });
});

test("the API's own 404 means the link is already gone, which is success", () => {
  expect(
    alreadyUnlinked(
      new ClientError(
        "Linked account not found.",
        404,
        "LINKED_ACCOUNT_NOT_FOUND",
      ),
    ),
  ).toBe(true);
});

test("a 404 without the API's code is a failed disconnect", () => {
  expect(alreadyUnlinked(new ClientError("Not Found", 404))).toBe(false);
  expect(alreadyUnlinked(new ClientError("Not found.", 404, "NOT_FOUND"))).toBe(
    false,
  );
  expect(alreadyUnlinked(new ClientError("boom", 500))).toBe(false);
});

test("copying succeeds when the clipboard accepts the text", async () => {
  const written: string[] = [];
  const ok = await copyText("link abc", {
    writeText: async (text: string) => {
      written.push(text);
    },
  });
  expect(ok).toBe(true);
  expect(written).toEqual(["link abc"]);
});

test("copying reports failure when the clipboard API is missing", async () => {
  expect(await copyText("link abc", undefined)).toBe(false);
});

test("copying reports failure when the write is rejected", async () => {
  const ok = await copyText("link abc", {
    writeText: async () => {
      throw new Error("denied");
    },
  });
  expect(ok).toBe(false);
});

test("the GitHub Connect button stays disabled from the request until the page leaves", () => {
  expect(connectGithubPending({ isPending: false, isSuccess: false })).toBe(
    false,
  );
  expect(connectGithubPending({ isPending: true, isSuccess: false })).toBe(
    true,
  );
  expect(connectGithubPending({ isPending: false, isSuccess: true })).toBe(
    true,
  );
});

test("one provider's page draws only that provider's link and offer", () => {
  expect(
    linkedAccountsSectionState({
      data: [row, slackRow],
      error: null,
      only: "slack",
      providers: { slack: true, github: true },
    })?.entries,
  ).toEqual([{ kind: "linked", account: slackRow }]);
  expect(
    linkedAccountsSectionState({
      data: [slackRow],
      error: null,
      only: "github",
      providers: { slack: true, github: true },
    })?.entries,
  ).toEqual([{ kind: "available", provider: "github", title: "GitHub" }]);
  expect(
    linkedAccountsSectionState({
      data: [slackRow],
      error: null,
      only: "github",
      providers: { slack: true, github: false },
    }),
  ).toBe(null);
});
