import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { NewBotSheet } from "@/components/agents/new-bot-sheet";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { SetupSections } from "@/components/bot-profile/setup";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentProfile } from "@/lib/agents/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";

/**
 * A Bot whose instructions run to the most they take, 5000 characters, for
 * bot-long-instructions-layout.test.tsx to bundle and load in a browser. `?screen=new-bot` opens
 * the New Bot sheet; anything else, the Bot's Setup page. The server's answers come from a fetch
 * here, as the API gives them, and a change is kept and read back.
 */
setCurrentOrganization("default");
queryClient.setDefaultOptions({
  queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
});
queryClient.setQueryData(deploymentKeys.capabilities(), {
  generativeUi: true,
  selfHostBanner: false,
  localEvaluation: false,
  edition: "team",
  builtInBots: true,
  isolatedBots: false,
});

/** Instructions as a person writes them: sentences and paragraphs, 5000 characters in all. */
const LONG_INSTRUCTIONS = (() => {
  const paragraph =
    "Review every expense report the day it arrives. Check each receipt against the policy, flag anything over the limit, and ask the submitter for a missing receipt before you approve. ";
  let text = "";
  while (text.length < 5000) text += `${paragraph.repeat(3).trim()}\n\n`;
  return text.slice(0, 5000);
})();

let bot: AgentProfile = {
  assignedToMe: false,
  runsOnOpenBotModel: true,
  keyFromOpenBot: false,
  id: "expense-review",
  name: "Expense Review",
  title: "Finance operations",
  roleDescription: LONG_INSTRUCTIONS,
  avatarSeed: "expense-review",
  visibility: "private",
  endpoint: null,
  builtIn: false,
  hasAuth: false,
  hasCallbackToken: false,
  isolated: false,
  isolationActive: false,
  isolationOffReason: null,
  hidden: false,
  pinned: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

const BOT_PATH = "/api/v2/organizations/default/bots/expense-review";

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input), location.origin).pathname;
  if (path === BOT_PATH && init?.method === "PATCH") {
    const body = JSON.parse(String(init.body));
    bot = { ...bot, name: body.name, roleDescription: body.roleDescription };
    return Response.json({ bot });
  }
  if (path === BOT_PATH) return Response.json({ bot });
  if (path === "/api/v2/people/me/capabilities")
    return Response.json({
      capabilities: { isolatedComputers: true },
      enforced: true,
    });
  if (path.endsWith("/giveable-apps"))
    return Response.json({ apps: [], nextCursor: null });
  return Response.json({ detail: "not served" }, { status: 404 });
}) as typeof fetch;

const newBot = new URLSearchParams(location.search).get("screen") === "new-bot";
const router = createRouter({
  routeTree: createRootRoute({
    component: newBot
      ? () => <NewBotSheet onClose={() => {}} onCreated={() => {}} open />
      : () => (
          <div className="h-svh overflow-auto bg-background text-foreground">
            <BotSubpage
              agentId="expense-review"
              description="Edit this Bot’s name, instructions and model."
              title="Setup"
            >
              {(agent) => <SetupSections agent={agent} />}
            </BotSubpage>
          </div>
        ),
  }),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router as never} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
