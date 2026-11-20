import type { Message } from "@ag-ui/core";
import {
  CopilotChatConfigurationProvider,
  CopilotKitProvider,
} from "@copilotkit/react-core/v2";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { TooltipProvider } from "@/components/ui/tooltip";
import { generativeUiProviderOptions, OPENBOT_UI } from "@/lib/copilot/a2ui";

/**
 * A conversation with interfaces a Bot drew, as a page of its own for a2ui-frame.test.tsx to bundle
 * and load in Chromium. Each interface arrives the way the runtime delivers it, as a
 * `generative-ui-surface` activity, so CopilotKit's own renderer draws its frame around it.
 *
 * `?only=<surface>` draws one of them, under the starter request that asks for a trip budget.
 */
const THREAD = "thread-a2ui-frame";

type Component = Record<string, unknown> & { id: string; component: string };

function surface(surfaceId: string, components: Component[]): Message {
  return {
    id: `activity-${surfaceId}`,
    role: "activity",
    activityType: "generative-ui-surface",
    content: {
      surfaceId,
      target: "chat",
      catalogId: OPENBOT_UI.id,
      status: "ready",
      rejected: [],
      operations: [
        {
          version: "1.0",
          createSurface: {
            surfaceId,
            catalogId: OPENBOT_UI.id,
            dataModel: { transport: 100, lodging: 250, food: 80 },
          },
        },
        { version: "1.0", updateComponents: { surfaceId, components } },
      ],
    },
  };
}

const amount = (key: string, label: string): Component => ({
  id: key,
  component: "TextField",
  label,
  variant: "number",
  value: { "@path": `/${key}` },
});

/** What the trip budget starter draws: everything in one Card. */
const BUDGET: Component[] = [
  { id: "root", component: "Card", child: "body" },
  {
    id: "body",
    component: "Column",
    children: ["title", "caption", "total", "transport", "lodging", "food"],
  },
  {
    id: "title",
    component: "Text",
    text: "Weekend trip budget",
    size: "lg",
    strong: true,
  },
  {
    id: "caption",
    component: "Text",
    text: "Sample amounts, not live prices. Edit each cost to update the total.",
    color: "secondary",
    size: "sm",
  },
  {
    id: "total",
    component: "Text",
    strong: true,
    text: {
      "@call": "calc",
      args: {
        expression: "'Total $' + (transport + lodging + food)",
        transport: { "@path": "/transport" },
        lodging: { "@path": "/lodging" },
        food: { "@path": "/food" },
      },
    },
  },
  amount("transport", "Transport ($)"),
  amount("lodging", "Lodging ($)"),
  amount("food", "Food ($)"),
];

const SURFACES: Record<string, Component[]> = {
  budget: BUDGET,
  /** A Card that names itself for a screen reader. */
  labelled: [
    {
      id: "root",
      component: "Card",
      child: "line",
      accessibility: { label: "Packing list" },
    },
    { id: "line", component: "Text", text: "Passport, charger, rain jacket." },
  ],
  /** No Card at all: the frame is the only box the interface has. */
  plain: [
    { id: "root", component: "Column", children: ["heading", "line"] },
    {
      id: "heading",
      component: "Text",
      text: "Before you go",
      strong: true,
    },
    {
      id: "line",
      component: "Text",
      text: "Check the forecast and book the train by Thursday.",
      color: "secondary",
    },
  ],
  /** A Card that draws no box of its own. */
  section: [
    { id: "root", component: "Card", variant: "section", child: "line" },
    { id: "line", component: "Text", text: "Saturday: museum, then dinner." },
  ],
};

const only = new URLSearchParams(location.search).get("only");
const messages: Message[] = [
  {
    id: "u1",
    role: "user",
    content:
      "Build an interactive weekend trip budget in this conversation. Start with transport $100, lodging $200 and food $80.",
  },
  ...Object.entries(SURFACES)
    .filter(([name]) => !only || name === only)
    .map(([name, components]) => surface(name, components)),
];

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <CopilotKitProvider
        runtimeUrl="/api/copilotkit"
        {...generativeUiProviderOptions(true)}
      >
        <CopilotChatConfigurationProvider agentId="default" threadId={THREAD}>
          <TooltipProvider>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                height: "100vh",
              }}
            >
              <ChatTranscript messages={messages} restoring={false} />
            </div>
          </TooltipProvider>
        </CopilotChatConfigurationProvider>
      </CopilotKitProvider>
    </QueryClientProvider>,
  );
}
