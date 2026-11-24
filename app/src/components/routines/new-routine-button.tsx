import { IconClock, IconPlus } from "@/components/icons";
import { Link, useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useKit } from "@/skins/store";

/**
 * New routine, opening the create screen. `agentId` starts it out for one Bot.
 *
 * `outline` where it stands alone in an empty state. On a page's title row, the current kit's
 * primary button, as Figma draws New Bot and New routine; the legacy kit's `ghost`, as Add
 * credential and New skill are drawn there.
 */
export function NewRoutineButton({
  agentId,
  variant,
}: {
  agentId?: string;
  /** Absent, it is a page's own action: the current kit's 40px primary (Figma "routines"). */
  variant?: "ghost" | "outline";
}) {
  const currentKit = useKit() === "current";
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
      size={variant === undefined && currentKit ? "lg" : "sm"}
      variant={variant ?? (currentKit ? "default" : "ghost")}
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
