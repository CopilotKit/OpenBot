/**
 * The tasks task-report-chip.test.tsx draws: one per state a task's card can read, each with the
 * result it posted under its card, and one more whose result came back after the person had said
 * something else, so it lands away from its card.
 */
export const STATES = [
  "working",
  "needs",
  "done",
  "failed",
  "stopped",
] as const;
export type CardState = (typeof STATES)[number];

const NOW = new Date().toISOString();

export const TITLES: Record<CardState | "away", string> = {
  working: "Chart the last six months of revenue by region",
  needs: "Post the refunds batch summary in Slack",
  done: "Order heirloom tomato seeds from Fernhill Garden Supply",
  failed: "Compare quotes from the three caterers",
  stopped: "Draft the EU customer refunds guide",
  away: "Book a table for twelve in Capitol Hill next Friday",
};

export const RESULTS: Record<CardState | "away", string> = {
  working:
    "Revenue grew in every region; the West led with 18% over six months.",
  needs:
    "The summary is written, and it is waiting on Slack access to post it.",
  done: "Your order is confirmed: FH-2041, arriving Thursday.",
  failed: "Two of the three caterers answered; the third site did not load.",
  stopped: "The guide covers refunds in France and Germany so far.",
  away: "Booked at Nue for 7 PM: confirmation NUE-5521.",
};

/** A task as the API answers a read of it. */
export function apiTask(id: CardState | "away") {
  const state: CardState = id === "away" ? "done" : id;
  return {
    id: `task-${id}`,
    botId: "general-assistant",
    conversationId: `c-${id}`,
    threadId: `t-${id}`,
    title: TITLES[id],
    why: null,
    origin: "delegated",
    suggestionId: null,
    sourceApp: null,
    sourceLink: null,
    originConversationId: "c-main",
    agent: null,
    status: {
      working: "working",
      needs: "needs_input",
      done: "ready_for_review",
      failed: "failed",
      stopped: "failed",
    }[state],
    failure:
      state === "failed"
        ? "the caterers' site didn't answer"
        : state === "stopped"
          ? "you stopped it"
          : null,
    failedAt: state === "failed" || state === "stopped" ? NOW : null,
    stoppedAt: state === "stopped" ? NOW : null,
    workingSince: state === "working" ? NOW : null,
    tryingAgainAt: null,
    lastActivityAt: NOW,
    next:
      state === "needs"
        ? "This needs you: Slack isn't ready for this Bot yet"
        : null,
    resolvedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
