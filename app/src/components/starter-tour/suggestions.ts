import type { CopilotChatSuggestionViewProps } from "@copilotkit/react-core/v2";

type StarterSuggestion = CopilotChatSuggestionViewProps["suggestions"][number];

/** Draws editable controls, so it needs generated interfaces switched on for this installation. */
export const INTERACTIVE_STARTER: StarterSuggestion = {
  title: "Build a trip budget",
  message:
    "Build an interactive weekend trip budget in this conversation. Start with transport $100, lodging $200 and food $80. Let me edit each cost and see the total update immediately. Use clearly labeled sample amounts, not live prices.",
  isLoading: false,
};

/**
 * A tour of what a Bot does best: search with a chart, its own computer, a connected app, and an
 * interface it draws. Starter requests are ordinary user messages, never Bot instructions or
 * generated suggestions.
 */
export const STARTER_SUGGESTIONS: CopilotChatSuggestionViewProps["suggestions"] =
  [
    {
      title: "Chart Hacker News",
      message:
        "Use web search to find the top 10 stories on the Hacker News front page right now. Show me a bar chart of them by points, then list them with their points and links.",
      isLoading: false,
    },
    {
      title: "Browse Google Maps",
      message:
        "Use your browser to open Google Maps and check the British Museum's Saturday opening hours. Then get walking directions from King's Cross station, list them step by step, and tell me when to leave to arrive at opening time. Don't sign in or change anything.",
      isLoading: false,
    },
    {
      title: "Triage my inbox",
      message:
        "Use Gmail to read my emails from the past 24 hours and tell me the top 2 that need my attention, and why. Don't mark anything as read or change anything. If Gmail isn't connected, help me connect it here, then continue this request.",
      isLoading: false,
    },
    INTERACTIVE_STARTER,
  ];

export type StarterTourState = {
  starterTourChannelId?: string;
};

/** Before a conversation exists, offer the unclaimed tour. Afterwards, only its saved conversation. */
export function showStarterTour(
  state: StarterTourState,
  channelId?: string,
): boolean {
  return channelId
    ? state.starterTourChannelId === channelId
    : state.starterTourChannelId === undefined;
}
