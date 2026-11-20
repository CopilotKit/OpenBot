import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { BotDelegation } from "@/components/bot-profile/delegation";
import { Checkbox } from "@/components/ui/checkbox";
import type { AgentProfile } from "@/lib/agents/queries";
import type {
  BotAgent,
  BotDelegation as Delegation,
} from "@/lib/api/generated/model";
import { botAgentKeys } from "@/lib/bot-agents/queries";
import { modelKeys } from "@/lib/models/queries";
import { setCurrentOrganization } from "@/lib/organizations/current";
import { queryClient } from "@/query-client";

/**
 * Unticked tickboxes where the app draws them, as a page of its own for checkbox-contrast.test.tsx
 * to bundle and load in a browser: a Bot's Agents page handing work to agents (the app's own
 * `BotDelegation`, one agent ticked and two not), and the tickbox on each surface the other screens
 * put it on: the page, a card, a menu or dialog, and a row filled with `bg-muted/50` on a card. The
 * test sets light or dark on the page's root, as the app's theme does.
 *
 * What the server would answer is put in the query cache before the page draws, and kept fresh, so
 * nothing is asked of a server.
 */
setCurrentOrganization("default");

const agent = (id: string, name: string, description: string): BotAgent => ({
  id,
  name,
  description,
  kind: "openbot",
  visibility: "public",
  endpoint: null,
  framework: "OpenBot",
  model: null,
  skills: [],
  hasAuth: false,
  hasCallbackToken: false,
  builtIn: false,
  canManage: true,
  mine: true,
  botCount: 1,
  createdAt: "2026-11-15T09:00:00.000Z",
  updatedAt: "2026-11-15T09:00:00.000Z",
});

const OPENBOT = agent(
  "agent_openbot",
  "OpenBot",
  "OpenBot's own agent, with every app and component the Bot may use.",
);
const NUMBERS = agent(
  "agent_numbers",
  "Numbers desk",
  "Works out figures: calculations, interest and loan schedules, percentages, budgets and tables of numbers.",
);
const COPY = agent(
  "agent_copy",
  "Copy desk",
  "Writes and edits words: announcements, emails, taglines, poems and short marketing copy.",
);

const DELEGATION: Delegation = {
  botId: "margin-notes",
  mode: "orchestrate",
  model: null,
  effort: null,
  instructions: "",
  agents: [
    {
      id: OPENBOT.id,
      name: OPENBOT.name,
      description: OPENBOT.description,
      kind: "openbot",
      framework: "OpenBot",
      available: true,
    },
  ],
  canManage: true,
};

queryClient.setQueryDefaults(["bot-agents"], { staleTime: Infinity });
queryClient.setQueryDefaults(["models"], { staleTime: Infinity });
queryClient.setQueryData(botAgentKeys.delegation(DELEGATION.botId), DELEGATION);
queryClient.setQueryData(botAgentKeys.list(), [OPENBOT, NUMBERS, COPY]);
queryClient.setQueryData(modelKeys.catalogue, { models: [] });

/** One unticked tickbox with its label, on a surface of the app's. */
function OnSurface({ id, surface }: { id: string; surface: string }) {
  return (
    <div className={`flex items-center gap-3 rounded-lg p-3 ${surface}`}>
      <Checkbox data-surface={id} id={`on-${id}`} />
      <label className="text-sm" htmlFor={`on-${id}`}>
        On {id}
      </label>
    </div>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <main className="min-h-svh bg-background p-6 text-foreground">
        <div className="mx-auto grid max-w-2xl gap-6" data-screen="agents">
          <BotDelegation
            agent={{ id: DELEGATION.botId } as unknown as AgentProfile}
          />
        </div>
        <div
          className="mx-auto mt-6 grid max-w-2xl gap-3"
          data-screen="surfaces"
        >
          <OnSurface id="page" surface="bg-background" />
          <div className="rounded-xl bg-card p-3">
            <OnSurface id="card" surface="bg-card" />
            <OnSurface id="muted row" surface="bg-muted/50" />
          </div>
          <OnSurface id="popover" surface="bg-popover" />
        </div>
      </main>
    </QueryClientProvider>,
  );
