import { IconPlus } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import { BotRoster } from "@/components/bots/bot-roster";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";

/** Creating a Bot is a search-parameter state, so the roster stays mounted and Back closes it. */
export const Route = createFileRoute("/_authed/_app/bots/")({
  validateSearch: z.object({ new: z.boolean().optional() }),
  component: BotsPage,
});

function BotsPage() {
  const { new: creating } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <PageShell
      action={
        <Button
          render={(props) => (
            <Link {...props} search={{ new: true }} to="/bots" />
          )}
          size="lg"
        >
          <IconPlus />
          New Bot
        </Button>
      }
      description="Every Bot you can reach: what each is doing, what it needs from you, and whether it is paused."
      title="Bots"
    >
      <BotRoster />
      <CreateAgentDialog
        onClose={() => void navigate({ search: {} })}
        onCreated={(agentId) =>
          void navigate({
            params: { agentId },
            search: {},
            to: "/bots/$agentId",
          })
        }
        open={creating === true}
      />
    </PageShell>
  );
}
