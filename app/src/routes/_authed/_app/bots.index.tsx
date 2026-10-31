import { IconPlus } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { NewBotSheet } from "@/components/agents/new-bot-sheet";
import { BotRoster } from "@/components/bots/bot-roster";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";

/** Just longer than the sheet's 200ms exit, so it has finished sliding away before the page changes. */
const SHEET_CLOSE_MS = 240;

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
          size="sm"
          variant="ghost"
        >
          <IconPlus />
          New Bot
        </Button>
      }
      description="Manage your Bots and access those shared with you."
      title="Bots"
    >
      <BotRoster />
      <NewBotSheet
        onClose={() => void navigate({ search: {} })}
        onCreated={(agentId) => {
          /*
           * Close first, then go. Navigating straight to the Bot unmounted this page with the sheet
           * still on it, so it vanished instead of sliding away. Replacing the `?new` entry means Back
           * from the new Bot lands on the roster, not on an empty sheet.
           */
          void navigate({ replace: true, search: {} });
          window.setTimeout(
            () =>
              void navigate({
                params: { agentId },
                search: {},
                to: "/bots/$agentId",
              }),
            SHEET_CLOSE_MS,
          );
        }}
        open={creating === true}
      />
    </PageShell>
  );
}
