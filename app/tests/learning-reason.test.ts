import { expect, test } from "bun:test";
import { proposalReason } from "@/lib/learning/display";

/**
 * Why Learning proposes a skill, as a proposal's dialog shows it. Learning writes a reason in words, or, for a skill it
 * reduced from its final insights, a line naming those insights by slug, which a person can't read and which the
 * dialog's Learned from already shows in full.
 */

test("a reason in words is shown as Learning wrote it", () => {
  expect(
    proposalReason(
      "Three support conversations checked the order date by hand.",
    ),
  ).toBe("Three support conversations checked the order date by hand.");
});

test("a reason that only names insights by slug is left out", () => {
  // As the live rc.13 run showed it.
  expect(
    proposalReason(
      "Supported by final Insights: agui-structured-component-report.",
    ),
  ).toBeNull();
  expect(
    proposalReason(
      "Supported by final Insights: refund-triage, order-date-check.",
    ),
  ).toBeNull();
  expect(proposalReason("Supported by Insight: refund-triage")).toBeNull();
});

test("a reason that names insights by underscored alias is left out whole, not cut to a fragment", () => {
  // Learning writes an added skill's reason as "Supported by final Insights: <aliases>.", and its
  // agent names its insights as it likes: a live run on Intelligence 0.16.0-rc.13 named them in snake
  // case, and the dialog showed "_payment_summary_house_rules." under Why.
  expect(
    proposalReason(
      "Supported by final Insights: vendor_payment_summary_house_rules.",
    ),
  ).toBeNull();
  expect(
    proposalReason(
      "Supported by final Insights: vendor_payments_house_format.",
    ),
  ).toBeNull();
  expect(
    proposalReason(
      "Supported by final Insights: agui_component_final_report, vendor_payments_house_format.",
    ),
  ).toBeNull();
  expect(
    proposalReason("Supported by final Insights: invoiceTotals, refund.v2."),
  ).toBeNull();
});

test("words beside the slugs are kept, and the slugs dropped", () => {
  expect(
    proposalReason(
      "Supported by final Insights: refund-triage. Refunds were checked by hand in three conversations.",
    ),
  ).toBe("Refunds were checked by hand in three conversations.");
  expect(
    proposalReason(
      "Supported by final Insights: vendor_payments_house_format. Summaries were corrected by hand.",
    ),
  ).toBe("Summaries were corrected by hand.");
});

test("an empty reason is left out", () => {
  expect(proposalReason("")).toBeNull();
  expect(proposalReason("   ")).toBeNull();
});
