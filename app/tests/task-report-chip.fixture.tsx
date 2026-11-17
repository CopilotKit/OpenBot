import type { Message } from "@ag-ui/core";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import {
  DELEGATE_TOOL,
  taskReportMessageId,
} from "@openbot/shared/orchestration";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OrchestrationTools } from "@/lib/copilot/orchestration-tools";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";
import { RESULTS, STATES, TITLES } from "./task-report-chip.data";

/**
 * A conversation in which the Bot handed out a task for each state its card can read, as it is
 * drawn when opened again: each ask, the Bot's line and its `delegate` call with the task's card,
 * and the task's result posted under it. The last task's result came back after the person had
 * asked something else, so it lands away from its card. For task-report-chip.test.tsx to bundle and
 * load in a real browser; the tasks themselves are read from the API the test answers.
 */
function handedOut(id: string, title: string): Message[] {
  return [
    { id: `u-${id}`, role: "user", content: `Please ${title.toLowerCase()}` },
    {
      id: `a-${id}`,
      role: "assistant",
      content: "On it. I've started a task for that.",
      toolCalls: [
        {
          id: `call-${id}`,
          type: "function",
          function: {
            name: DELEGATE_TOOL,
            arguments: JSON.stringify({
              title,
              brief: `${title}, and report back with what you found.`,
            }),
          },
        },
      ],
    },
    {
      id: `r-${id}`,
      role: "tool",
      toolCallId: `call-${id}`,
      content: JSON.stringify({
        taskId: `task-${id}`,
        channelId: `c-${id}`,
        title,
      }),
    },
  ];
}

function result(id: string, words: string): Message {
  return {
    id: taskReportMessageId("result", `task-${id}`, "run-1"),
    role: "assistant",
    content: words,
  };
}

const messages: Message[] = [
  ...STATES.flatMap((state) => [
    ...handedOut(state, TITLES[state]),
    result(state, RESULTS[state]),
  ]),
  ...handedOut("away", TITLES.away),
  { id: "u-meanwhile", role: "user", content: "What's on my calendar today?" },
  {
    id: "a-meanwhile",
    role: "assistant",
    content: "Two meetings: design review at 11 and a 1:1 at 3.",
  },
  result("away", RESULTS.away),
];

function Conversation() {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <ChatTranscript messages={messages} restoring={false} />
    </div>
  );
}

const rootRoute = createRootRoute({ component: Conversation });
const router = createRouter({
  routeTree: rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/channel/$channelId",
      component: () => null,
    }),
  ]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

// The person's organization, as the signed-in gate sets it before any screen draws.
setCurrentOrganization("default");

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider runtimeUrl="/api/copilotkit">
        <OrchestrationTools />
        <TooltipProvider>
          <RouterProvider router={router as never} />
        </TooltipProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}
