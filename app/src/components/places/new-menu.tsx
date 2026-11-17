import {
  IconClockPlus,
  IconMessagePlus,
  IconPlayerRecord,
  IconRobot,
  IconRobotFace,
} from "@tabler/icons-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { cloneElement, type ReactElement, useState } from "react";
import { NewBotSheet } from "@/components/agents/new-bot-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** What happens once the Bot the person is making exists. */
type Then = "bot" | "routine";

/**
 * The "+" menu: start a conversation, a Bot, a routine or a recorded task. The caller passes its own
 * button, so the strip keeps one toolbar; `onNavigate` lets it close what the menu was opened from,
 * the phone's sheet, once a choice takes the person somewhere.
 */
export function NewMenu({
  trigger,
  onNavigate,
}: {
  trigger: ReactElement<{ "aria-label"?: string }>;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const [then, setThen] = useState<Then | null>(null);

  function created(agentId: string) {
    const next = then;
    setThen(null);
    onNavigate?.();
    if (next === "routine") {
      void navigate({ search: { agentId }, to: "/routines/new" });
    } else {
      void navigate({ params: { agentId }, to: "/bots/$agentId" });
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={cloneElement(trigger, { "aria-label": "New" })}
        />
        <DropdownMenuContent
          align="start"
          className="w-auto min-w-56"
          side="right"
        >
          <DropdownMenuItem
            nativeButton={false}
            onClick={onNavigate}
            render={<Link to="/channel/new" />}
          >
            <IconMessagePlus />
            New conversation
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setThen("bot")}>
            <IconRobot />
            New Bot
          </DropdownMenuItem>
          <DropdownMenuItem
            nativeButton={false}
            onClick={onNavigate}
            render={<Link to="/routines/new" />}
          >
            <IconClockPlus />
            New routine
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setThen("routine")}>
            <IconRobotFace />
            New routine for a new Bot
          </DropdownMenuItem>
          <DropdownMenuItem
            nativeButton={false}
            onClick={onNavigate}
            render={<Link to="/browser" />}
          >
            <IconPlayerRecord />
            Record a task
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NewBotSheet
        onClose={() => setThen(null)}
        onCreated={created}
        open={then !== null}
      />
    </>
  );
}
