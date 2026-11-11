import {
  IconBook,
  IconBrain,
  IconChevronRight,
  IconPlus,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { NewBotSheet } from "@/components/agents/new-bot-sheet";
import { BotRoster } from "@/components/bots/bot-roster";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  deploymentCapabilitiesQueryOptions,
  useOffersMemory,
} from "@/lib/deployment/queries";

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
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
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
      description={
        personal
          ? "Your Bots for everyday work."
          : "Manage your Bots and access those shared with you."
      }
      title="Bots"
    >
      <BotRoster />
      <WhatYourBotsLearn />
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

/**
 * Learns, the pair of Memory and Skills, beneath the Bots themselves: what every Bot knows about you
 * and how to do things. Both have their own page in the main menu. No Memory row where OpenBot doesn't
 * offer memory (see `offersMemory`).
 */
function WhatYourBotsLearn() {
  const memory = useOffersMemory();
  return (
    <PageSection title="What your Bots learn">
      <PageRows>
        {memory ? (
          <>
            <Item render={<Link to="/memory" />} size="sm">
              <ItemMedia variant="icon">
                <IconBrain />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Memory</ItemTitle>
                <ItemDescription>
                  What your Bots remember about you and your work.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </ItemActions>
            </Item>
            <Separator />
          </>
        ) : null}
        <Item render={<Link to="/skills" />} size="sm">
          <ItemMedia variant="icon">
            <IconBook />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Skills</ItemTitle>
            <ItemDescription>
              Step-by-step instructions you wrote, taught or your Bots learned.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}
