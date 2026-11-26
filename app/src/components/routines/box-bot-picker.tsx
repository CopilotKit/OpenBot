import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { BotOrb } from "@/components/agents/bot-orb";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";

/** Where the Routines box remembers the Bot picked last, in this browser. */
export const BOX_BOT_KEY = "openbot.routines.boxBot";

/** What was stored, or nothing: a browser that blocks storage reads as nothing stored. */
function storedBot(): string | null {
  try {
    return window.localStorage.getItem(BOX_BOT_KEY);
  } catch {
    return null;
  }
}

/**
 * The Bots the box can make a routine for, and the one it is on: the Bot picked last (kept in
 * this browser), else the first listed, else none.
 */
export function useBoxBot(): {
  bots: AgentProfile[] | undefined;
  isPending: boolean;
  isError: boolean;
  bot: AgentProfile | null;
  pick(id: string): void;
} {
  const agents = useQuery(agentListQueryOptions());
  const [pickedId, setPickedId] = useState<string | null>(storedBot);
  const bots = agents.data;
  const bot =
    bots?.find((candidate) => candidate.id === pickedId) ?? bots?.[0] ?? null;

  return {
    bots,
    isPending: agents.isPending,
    isError: agents.isError,
    bot,
    pick(id) {
      setPickedId(id);
      try {
        window.localStorage.setItem(BOX_BOT_KEY, id);
      } catch {
        // Not remembered: the pick still shows for as long as the page is open.
      }
    },
  };
}

/** The Bot the box makes the routine for. No border: it sits inside the box's rounded bar. */
export function BoxBotPicker({
  bots,
  value,
  onChange,
  disabled,
}: {
  bots: AgentProfile[];
  value: string | null;
  onChange(id: string): void;
  disabled?: boolean;
}) {
  const items = Object.fromEntries(bots.map((bot) => [bot.id, bot.name]));

  return (
    <Select
      disabled={disabled}
      items={items}
      onValueChange={(next) => {
        if (next) onChange(String(next));
      }}
      value={value}
    >
      <SelectTrigger
        aria-label="Bot"
        className="border-transparent bg-transparent font-medium"
        size="sm"
      >
        <SelectValue>
          {(id: string | null) => {
            const bot = bots.find((candidate) => candidate.id === id);
            return bot ? (
              <>
                <BotOrb name={bot.name} seed={bot.avatarSeed} size={18} />
                {bot.name}
              </>
            ) : null;
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {bots.map((bot) => (
            <SelectItem key={bot.id} value={bot.id}>
              {/* Hidden: the name beside it already says who. */}
              <span aria-hidden="true" className="contents">
                <BotOrb name={bot.name} seed={bot.avatarSeed} size={18} />
              </span>
              {bot.name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** What the box says when there is no Bot to make a routine for. */
export function NoBotsYet() {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-muted-foreground text-sm">
        Make a Bot first to give it routines.
      </p>
      <Button
        render={(props) => (
          <Link {...props} search={{ new: true }} to="/bots" />
        )}
        size="sm"
        variant="outline"
      >
        New Bot
      </Button>
    </div>
  );
}
