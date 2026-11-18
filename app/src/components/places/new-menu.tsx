import {
  IconMessagePlus,
  IconPlayerRecord,
  IconRobot,
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

/**
 * The "+" menu: start a conversation, a Bot or a recorded task. When a Bot works on its own is set on
 * the Bot, so a new Bot's page is where that starts. The caller passes its own button, so the strip
 * keeps one toolbar; `onNavigate` lets it close what the menu was opened from, the phone's sheet,
 * once a choice takes the person somewhere.
 */
export function NewMenu({
  trigger,
  onNavigate,
}: {
  trigger: ReactElement<{ "aria-label"?: string }>;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const [making, setMaking] = useState(false);

  function created(agentId: string) {
    setMaking(false);
    onNavigate?.();
    void navigate({ params: { agentId }, to: "/bots/$agentId" });
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
          <DropdownMenuItem onClick={() => setMaking(true)}>
            <IconRobot />
            New Bot
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
        onClose={() => setMaking(false)}
        onCreated={created}
        open={making}
      />
    </>
  );
}
