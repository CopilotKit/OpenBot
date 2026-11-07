import type { CopilotChatSuggestionViewProps } from "@copilotkit/react-core/v2";

/** Starter requests are ordinary user messages, never Bot instructions or generated suggestions. */
export const STARTER_SUGGESTIONS: CopilotChatSuggestionViewProps["suggestions"] =
  [
    {
      title: "Summarize email",
      message:
        "Use Gmail to summarize my five most recent unread emails, with a link to each message. If Gmail isn't connected, help me connect it here, then continue this request. Don't mark the emails as read or send anything.",
      isLoading: false,
    },
    {
      title: "Build a trip budget",
      message:
        "Build an interactive weekend trip budget in this conversation. Start with transport $100, lodging $200 and food $80. Let me edit each cost and see the total update immediately. Use clearly labeled sample amounts, not live prices.",
      isLoading: false,
    },
    {
      title: "Find weekend plans",
      message:
        "Find three things to do this weekend in my city. Ask me which city if you don't know. Use web search and fetch tools only, without opening or navigating a browser. Read the source pages to verify each event's date and any price or free-admission claim. Include dates and source links, and leave out details you cannot verify. If those tools aren't available, help me set up search instead of switching to the browser.",
      isLoading: false,
    },
    {
      title: "Read a webpage",
      message:
        "Help me try reading a page with your browser. Ask me for a page URL, open it in the browser, and give me three facts from the page with its link. Don't submit forms or change anything on the site.",
      isLoading: false,
    },
    {
      title: "Try a browser task",
      message:
        "Use your browser to open https://demo.playwright.dev/todomvc/ and add a task named Try OpenBot. This is a demo checklist. Follow any approval requests, then reload the page and check that the task is still there. Tell me what you observed after reloading. Don't change or delete existing tasks.",
      isLoading: false,
    },
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
