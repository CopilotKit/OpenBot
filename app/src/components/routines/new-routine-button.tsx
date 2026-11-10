import { IconChevronDown, IconClock, IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { NewResponsibilityDialog } from "@/components/responsibilities/new-responsibility-dialog";
import { TurnOnResearchDialog } from "@/components/suggestions/proactive-panel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { proactiveSettingsQueryOptions } from "@/lib/proactive";

/**
 * New on the Routines page: a menu of the three kinds, each opening what it opened before. A
 * routine opens the create screen, a goal and a check-in their dialogs. The menu also says the
 * usual way: asking a Bot. `agentId` starts each one out for that Bot.
 *
 * A Bot has at most one check-in, so for a Bot that has one the menu leaves it out; its own row
 * turns it on and off.
 *
 * `outline` where it stands alone in an empty state, `ghost` on a page's title row.
 */
export function NewRoutineMenu({
  agentId,
  variant = "ghost",
}: {
  agentId?: string;
  variant?: "ghost" | "outline";
}) {
  const router = useRouter({ warn: false });
  const checkIns = useQuery(proactiveSettingsQueryOptions());
  const [creating, setCreating] = useState<"goal" | "check-in" | null>(null);
  // A list drawn with no router around it, as a skin's own tests draw it, has nowhere to link to.
  if (!router) return null;
  const canAddCheckIn =
    agentId === undefined ||
    (checkIns.isSuccess &&
      !checkIns.data.some((setting) => setting.agentId === agentId));
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button size="sm" variant={variant}>
              <IconPlus />
              New
              <IconChevronDown />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuGroup>
            <DropdownMenuItem
              render={
                <Link search={agentId ? { agentId } : {}} to="/routines/new" />
              }
            >
              Routine
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setCreating("goal")}>
              Goal
            </DropdownMenuItem>
            {canAddCheckIn ? (
              <DropdownMenuItem onClick={() => setCreating("check-in")}>
                Check-in
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel className="font-normal">
              Or ask a Bot in a conversation, like “every weekday at 9, send
              me…”.
            </DropdownMenuLabel>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {creating === "goal" ? (
        <NewResponsibilityDialog
          agentId={agentId}
          onClose={() => setCreating(null)}
        />
      ) : null}
      {creating === "check-in" ? (
        <TurnOnResearchDialog
          fixedBot={agentId}
          onClose={() => setCreating(null)}
        />
      ) : null}
    </>
  );
}

/**
 * New routine, opening the create screen. `agentId` starts it out for one Bot.
 *
 * `outline` where it stands alone in an empty state, `ghost` on a page's title row, as Add
 * credential and New skill are drawn.
 */
export function NewRoutineButton({
  agentId,
  variant = "ghost",
}: {
  agentId?: string;
  variant?: "ghost" | "outline";
}) {
  // A list drawn with no router around it, as a skin's own tests draw it, has nowhere to link to.
  if (!useRouter({ warn: false })) return null;
  return (
    <Button
      render={(props) => (
        <Link
          {...props}
          search={agentId ? { agentId } : {}}
          to="/routines/new"
        />
      )}
      size="sm"
      variant={variant}
    >
      <IconPlus />
      New routine
    </Button>
  );
}

/**
 * The clock beside a conversation's `+`: set up a routine for this Bot, posting here.
 *
 * Opens the same create screen as the Routines page, with the Bot and this conversation already
 * chosen, so the person only says what to do and when. A screen rather than a starter typed into the
 * box, because the box sends to the Bot and the Bot would then have to ask when.
 */
export function RoutineComposerButton({
  agentId,
  channelId,
}: {
  agentId: string;
  channelId: string;
}) {
  /*
   * A link needs a router to follow. The conversation always has one in the app; a conversation
   * drawn on its own, as its tests draw it, has nowhere to go, so it draws no clock.
   */
  if (!useRouter({ warn: false })) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Set up a routine"
            data-slot="composer-routine"
            render={(props) => (
              <Link
                {...props}
                search={{ agentId, channelId }}
                to="/routines/new"
              />
            )}
            size="icon"
            variant="ghost"
          >
            <IconClock className="size-5" />
          </Button>
        }
      />
      <TooltipContent>Set up a routine</TooltipContent>
    </Tooltip>
  );
}
