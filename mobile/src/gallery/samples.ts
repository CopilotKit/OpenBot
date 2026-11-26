/**
 * A sample of every card, for the development gallery (`/gallery?only=bot cards`): the web app's
 * GALLERY `preview` arguments, so the phone's cards are seen with what the web app shows.
 */
import type { DrawnComponent } from "../api/generated/model";

const sample = (
  name: string,
  args: Record<string, unknown>,
): DrawnComponent => ({
  toolCallId: `sample-${name}`,
  name,
  arguments: args,
});

export const GALLERY_SAMPLES: DrawnComponent[] = [
  sample("showBarChart", {
    basis: "given",
    title: "Revenue by team",
    caption: "Sales leads, and Engineering is closing the gap.",
    points: [
      { label: "Sales", value: 120 },
      { label: "Engineering", value: 80 },
      { label: "Support", value: 45 },
    ],
  }),
  sample("showPieChart", {
    basis: "given",
    title: "Where the month went",
    points: [
      { label: "Build", value: 48 },
      { label: "Support", value: 26 },
      { label: "Meetings", value: 26 },
    ],
  }),
  sample("showLineChart", {
    basis: "given",
    title: "Signups",
    caption: "Six weeks, one release.",
    labels: ["W1", "W2", "W3", "W4", "W5", "W6"],
    series: [{ name: "Signups", values: [120, 180, 160, 240, 300, 420] }],
  }),
  sample("showAreaChart", {
    basis: "given",
    title: "Storage used",
    caption: "Growing steadily since the migration.",
    labels: ["Jan", "Feb", "Mar", "Apr", "May"],
    series: [{ name: "TB", values: [12, 19, 26, 31, 44] }],
  }),
  sample("showProgress", {
    basis: "given",
    title: "Migration to the new runtime",
    caption: "Two services left.",
    points: [
      { label: "Services moved", value: 18, target: 20 },
      { label: "Tests ported", value: 240, target: 240 },
    ],
  }),
  sample("showRecord", {
    title: "Invoice 2043",
    subtitle: "Northwind Traders",
    status: "Approved",
    fields: [
      { label: "Amount", value: "$4,280.00" },
      { label: "Raised", value: "12 March" },
      { label: "Owner", value: "Priya Raman" },
    ],
  }),
  sample("showMetrics", {
    title: "This month",
    metrics: [
      {
        label: "Revenue",
        value: "$412k",
        change: "+12% on last month",
        changeTone: "positive",
      },
      { label: "Open deals", value: "38" },
      {
        label: "Churn",
        value: "1.4%",
        change: "+0.3pt",
        changeTone: "caution",
      },
    ],
  }),
  sample("showChecklist", {
    title: "Before the release",
    items: [
      { text: "Migrations applied", done: true },
      { text: "Changelog written", done: true },
      { text: "Load test", done: false, note: "Waiting on staging" },
    ],
  }),
  sample("showNotice", {
    title: "Certificate expires in 30 days",
    body: "The checkout certificate has an owner now, and this is the first of the new alerts.",
    tone: "caution",
    points: ["Owner: Platform", "Renews automatically once approved"],
  }),
  sample("showTable", {
    title: "Team capacity",
    caption: "Three teams, one shared launch. Hours available this week.",
    columns: ["Team", "Available hours", "Focus"],
    rows: [
      { cells: ["Product", 24, "Customer onboarding"] },
      { cells: ["Engineering", 72, "Release readiness"] },
      { cells: ["Design", 18, "Workspace polish"] },
    ],
  }),
  sample("showQuote", {
    quote:
      "Meals under $75 need no receipt. Anything above needs one, and anything above $500 needs your manager before you spend it.",
    attribution: "the expense policy",
    context: "Last changed in March.",
  }),
  // The web app has no preview of this one: it reads real figures. The gallery hands it made-up ones.
  sample("showActivityReport", { report: "activity", days: 7 }),
  sample("askApproval", {
    title: "Refund this order?",
    summary:
      "The customer was charged twice for the same order and the second charge has not settled.",
    details: [
      { label: "Amount", value: "$128.40" },
      { label: "Customer", value: "Northwind Traders" },
      { label: "Order", value: "2043" },
    ],
    approveLabel: "Refund",
  }),
  sample("askChoice", {
    title: "Which environment should this go to?",
    summary: "The build is green and nothing else is queued.",
    options: [
      { id: "staging", label: "Staging", description: "Safe, and reversible" },
      { id: "production", label: "Production", description: "Live customers" },
    ],
  }),
  sample("askForm", {
    title: "Plan your next project",
    description: "Provide a few details to help prepare your first draft.",
    fields: [
      { id: "team", label: "Team name", type: "text", required: true },
      { id: "email", label: "Work email", type: "email", required: true },
      {
        id: "priority",
        label: "Priority",
        type: "select",
        options: ["This week", "This month", "Exploring"],
      },
      { id: "seats", label: "People involved", type: "number", min: 1 },
      {
        id: "notes",
        label: "What would a good outcome look like?",
        type: "textarea",
      },
    ],
    submitLabel: "Prepare my brief",
  }),
];
