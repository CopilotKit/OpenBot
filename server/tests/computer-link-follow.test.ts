import { describe, expect, test } from "bun:test";
import { safetyRequirement } from "../src/approvals/policy";
import type { ApprovalCandidate } from "../src/approvals/types";
import type { AuditEventInput, AuditStore } from "../src/audit";
import {
  ComputerStoppedError,
  StaleSnapshotError,
} from "../src/computer/client";
import { botSeat } from "../src/computer/computer-key";
import {
  ActionRefusedError,
  createComputerGateway,
  followableLink,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { ComputerProvider } from "../src/computer/provider";
import type { SnapshotResult } from "../src/computer/schema";

/**
 * Following a link is opening its address, so it is judged as one.
 *
 * The case this exists for: a Bot reading an ordering system clicks "Material documents" on a page at
 * `/purchase-orders/PO-102`. As a click that is a change, the built-in payments requirement matches
 * "purchase" in the page address, and the person is handed a read to do. Typing the same address was
 * already a read. These pin that the two are now the same action, and that nothing which is not a
 * plain link to another page changes at all.
 */

const PAGE = "https://erp.example/purchase-orders/PO-102";

const SNAPSHOT: SnapshotResult = {
  snapshotId: 3,
  url: PAGE,
  title: "Purchase order PO-102",
  truncated: false,
  elements: [
    {
      ref: "e2",
      role: "link",
      name: "Material documents for PO-102",
      url: "https://erp.example/material-documents?po=PO-102",
    },
    { ref: "e3", role: "link", name: "Expand", url: `${PAGE}#` },
    { ref: "e4", role: "link", name: "Release", url: "javascript:void(0)" },
    { ref: "e5", role: "link", name: "Looks like a link" },
    { ref: "e6", role: "button", name: "Submit purchase order" },
    {
      ref: "e7",
      role: "link",
      name: "Delete PO-102",
      url: "https://erp.example/purchase-orders/PO-102/delete",
    },
  ],
};

function harness(options?: {
  policy?: ActionPolicy;
  /** What `/navigate` answers, for the challenge case. */
  navigated?: Record<string, unknown>;
  /** A status for `/navigate` to answer with instead, as the computer does for a stale citation. */
  navigateStatus?: number;
  /** Holds the action at the approval gate until this settles, as a person deciding would. */
  approvalHold?: Promise<void>;
}) {
  const reached: Array<{ path: string; body: unknown }> = [];
  const candidates: ApprovalCandidate[] = [];
  const rows: AuditEventInput[] = [];
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-person",
    locate: async () => "http://agent-computer:4100",
    status: async (seat) => ({ botId: seat.botId, state: "ready" }),
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    list: async () => [],
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/snapshot") return Response.json(SNAPSHOT);
    reached.push({ path, body });
    if (path === "/navigate" && options?.navigateStatus)
      return Response.json(
        { error: "That list of elements is out of date.", stale: true },
        { status: options.navigateStatus },
      );
    if (path === "/navigate")
      return Response.json({
        url: body?.url,
        title: "Material documents",
        text: "",
        truncated: false,
        elapsedMs: 4,
        ...options?.navigated,
      });
    if (path === "/click")
      return Response.json({ action: "click", url: PAGE, elapsedMs: 2 });
    return Response.json(
      { error: `Unknown endpoint: ${path}` },
      { status: 404 },
    );
  }) as unknown as typeof fetch;
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const gateway = createComputerGateway({
    provider,
    fetchImpl,
    auditStore,
    policy: () =>
      options?.policy ?? { mode: "enforce", deny: [], allow: ["true"] },
    approvalGate: async (candidate) => {
      candidates.push(candidate);
      await options?.approvalHold;
      return undefined;
    },
  });
  const seat = botSeat("bot-1");
  const click = async (ref: string, snapshotId = 3, signal?: AbortSignal) => {
    await gateway.snapshot(seat);
    return gateway.click(seat, { id: "user-1" }, { ref, snapshotId }, signal);
  };
  return { click, reached, candidates, rows };
}

describe("followableLink", () => {
  test("a link to another page is followed, by its full address", () => {
    expect(
      followableLink(
        { role: "link", url: "https://erp.example/purchase-orders?q=a#top" },
        PAGE,
      ),
    ).toBe("https://erp.example/purchase-orders?q=a#top");
  });

  test("a spot on the same page, javascript:, mailto: and no address are clicked", () => {
    for (const url of [
      `${PAGE}#`,
      `${PAGE}#lines`,
      PAGE,
      "javascript:void(0)",
      "mailto:ap@erp.example",
      "not a url",
      undefined,
    ])
      expect(followableLink({ role: "link", url }, PAGE)).toBeUndefined();
  });

  test("only a link: a button or menu item with an address is still clicked", () => {
    for (const role of ["button", "menuitem", "tab"])
      expect(
        followableLink({ role, url: "https://erp.example/other" }, PAGE),
      ).toBeUndefined();
  });
});

describe("a click on a link to another page", () => {
  test("opens the address instead of clicking, and says so", async () => {
    const { click, reached } = harness();
    const result = await click("e2");

    expect(reached).toEqual([
      {
        path: "/navigate",
        body: expect.objectContaining({
          url: "https://erp.example/material-documents?po=PO-102",
        }),
      },
    ]);
    expect(result).toMatchObject({
      action: "click",
      ref: "e2",
      element: { role: "link", name: "Material documents for PO-102" },
      opened: "https://erp.example/material-documents?po=PO-102",
      url: "https://erp.example/material-documents?po=PO-102",
    });
  });

  test("is a read to the approval gate, so the payments requirement does not take it", async () => {
    const { click, candidates } = harness();
    await click("e2");

    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;
    expect(candidate).toMatchObject({
      toolRef: "computer_navigate",
      effect: "read",
      scope: "erp.example",
    });
    expect(safetyRequirement(candidate as ApprovalCandidate)).toBeUndefined();
  });

  test("on a page about purchase orders, a button is still a change and still handed off", async () => {
    const { click, reached, candidates } = harness();
    await click("e6");

    expect(reached.map((call) => call.path)).toEqual(["/click"]);
    expect(candidates[0]).toMatchObject({
      toolRef: "computer_click",
      effect: "write",
    });
    expect(safetyRequirement(candidates[0] as ApprovalCandidate)?.id).toBe(
      "payments",
    );
  });

  test("a same-page link, a javascript: link and a link with no address are clicked as before", async () => {
    for (const ref of ["e3", "e4", "e5"]) {
      const { click, reached, candidates } = harness();
      await click(ref);
      expect(reached.map((call) => call.path)).toEqual(["/click"]);
      expect(candidates[0]?.effect).toBe("write");
    }
  });

  test("keeps the element in front of the policy: a rule about this link refuses the open", async () => {
    const { click, reached, rows } = harness({
      policy: {
        mode: "enforce",
        deny: ['contains(element.name, "Delete")'],
        allow: ["true"],
      },
    });

    await expect(click("e7")).rejects.toThrow(ActionRefusedError);
    expect(reached).toEqual([]);
    expect(rows.at(-1)?.eventType).toBe("computer.action_refused");
  });

  test("is checked against the destination, so a rule about where pages open applies", async () => {
    const { click, reached } = harness({
      policy: {
        mode: "enforce",
        deny: ['contains(page.url, "material-documents")'],
        allow: ["true"],
      },
    });

    await expect(click("e2")).rejects.toThrow(ActionRefusedError);
    expect(reached).toEqual([]);
  });

  test("a ref from a superseded snapshot opens nothing, and is refused as a click is", async () => {
    const { click, reached } = harness();
    // The stored snapshot is 3; a ref claiming 2 resolves to no element, so there is no link to open.
    await expect(click("e2", 2)).rejects.toThrow(StaleSnapshotError);
    expect(reached).toEqual([]);
  });

  test("a page asking for a person comes back on the click, as it does on a navigation", async () => {
    const challenge = {
      kind: "captcha",
      reason: "The page wants a person.",
      requestId: "req-1",
    };
    const { click } = harness({ navigated: { challenge } });
    const result = await click("e2");
    expect(result.challenge).toEqual(challenge as never);
  });
  test("carries its ref and snapshot to the computer, which checks them against the live page", async () => {
    const { click, reached } = harness();
    await click("e2");
    expect(reached[0]?.body).toMatchObject({ ref: "e2", snapshotId: 3 });
  });

  test("the browser has moved on but the stored snapshot has not: the computer's stale answer refuses it", async () => {
    // The server still holds snapshot 3, so the ref resolves here; only the computer knows the page
    // has changed since, and its 409 is what stops the old link opening.
    const { click } = harness({ navigateStatus: 409 });
    await expect(click("e2")).rejects.toThrow(StaleSnapshotError);
  });

  test("Stop pressed while it waits for approval opens nothing, as it does for a button", async () => {
    for (const ref of ["e2", "e6"]) {
      let release!: () => void;
      const approvalHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { click, reached, candidates } = harness({ approvalHold });
      const stop = new AbortController();
      const pending = click(ref, 3, stop.signal);
      while (candidates.length === 0)
        await new Promise((r) => setTimeout(r, 1));
      stop.abort();
      release();
      await expect(pending).rejects.toThrow(ComputerStoppedError);
      expect(reached).toEqual([]);
    }
  });
});
