/**
 * The cards the phone announces to OpenBot (./announce.ts), apart from the request so the tests can read them.
 */
import type { SHOWN } from "./drawn";

type Entry = {
  name: (typeof SHOWN)[number];
  title: string;
  kind: "chart" | "card";
  description: string;
};

/** The titles and kinds are the web app's (app/src/components/gallery). */
export const ANNOUNCED: readonly Entry[] = [
  {
    name: "showBarChart",
    title: "Bar chart",
    kind: "chart",
    description:
      "Show values for a few categories as a bar chart in the conversation.",
  },
  {
    name: "showPieChart",
    title: "Donut chart",
    kind: "chart",
    description: "Show how a whole splits into parts as a donut chart.",
  },
  {
    name: "showLineChart",
    title: "Line chart",
    kind: "chart",
    description: "Show how one or more values change over time as lines.",
  },
  {
    name: "showAreaChart",
    title: "Area chart",
    kind: "chart",
    description: "Show how a total changes over time as a filled area.",
  },
  {
    name: "showProgress",
    title: "Progress against target",
    kind: "chart",
    description: "Show how far a value has come toward its target.",
  },
  {
    name: "showRecord",
    title: "Record",
    kind: "card",
    description: "Show one record's fields as a card.",
  },
  {
    name: "showMetrics",
    title: "Headline figures",
    kind: "card",
    description: "Show a few headline figures side by side.",
  },
  {
    name: "showChecklist",
    title: "Checklist",
    kind: "card",
    description: "Show a list of items, each done or not.",
  },
  {
    name: "showNotice",
    title: "Notice",
    kind: "card",
    description: "Show a short notice the person should see.",
  },
  {
    name: "showTable",
    title: "Data table",
    kind: "card",
    description: "Show rows of data as a table.",
  },
  {
    name: "showQuote",
    title: "Quotation",
    kind: "card",
    description: "Show a quotation and who said it.",
  },
  {
    name: "showActivityReport",
    title: "Activity report",
    kind: "card",
    description: "Show a report of a Bot's recent activity.",
  },
];
