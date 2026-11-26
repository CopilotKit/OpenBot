import { IconX } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { BotOrb } from "@/components/agents/bot-orb";
import { Button } from "@/components/ui/button";
import type { BoxLine } from "@/lib/routines/box";
import { cn } from "@/lib/utils";

/** The link to where a routine, a goal or a check-in that was just made opens, drawn through a Button. */
function openMade(open: Extract<BoxLine, { kind: "made" }>["open"]) {
  switch (open.kind) {
    case "routine":
      return (
        <Link
          to="/routines/schedules/$routineId"
          params={{ routineId: open.id }}
        />
      );
    case "goal":
      return <Link to="/routines/goals/$goalId" params={{ goalId: open.id }} />;
    case "check-in":
      return (
        <Link
          to="/routines/check-ins/$checkInId"
          params={{ checkInId: open.id }}
        />
      );
  }
}

/** The one thing the line offers beside its words, or nothing. */
function LineAction({ line }: { line: BoxLine }) {
  switch (line.kind) {
    case "made":
      return (
        <Button variant="link" size="sm" render={openMade(line.open)}>
          Open
        </Button>
      );
    case "finish":
    case "useForm": {
      const draft = line.draft;
      return (
        <Button
          variant="link"
          size="sm"
          render={
            <Link
              to="/routines/new"
              search={{ agentId: line.botId }}
              state={draft ? { routineDraft: draft } : undefined}
            />
          }
        >
          {line.kind === "finish" ? "Finish" : "Use the form"}
        </Button>
      );
    }
    case "refused":
      if (line.fix !== "connectApp") return null;
      return (
        <Button variant="link" size="sm" render={<Link to="/connections" />}>
          Connect
        </Button>
      );
    case "maybeMade":
      return null;
  }
}

/**
 * The line under the Routines box: what the box did with the sentence, in the Bot's words, and at
 * most one action. The Bot's name leads the text, so it is set in the foreground colour once, and
 * the words wrap so a refusal reads whole. A refusal, or a routine that may not have been saved,
 * is amber.
 */
export function BoxLineView({
  line,
  bot,
  onDismiss,
}: {
  line: BoxLine;
  bot: { name: string; avatarSeed: string };
  onDismiss: () => void;
}) {
  const amber = line.kind === "refused" || line.kind === "maybeMade";
  const leadsWithName = line.text.startsWith(bot.name);
  return (
    <div role="status" className="flex items-center gap-2 text-sm">
      <BotOrb seed={bot.avatarSeed} name={bot.name} size={18} />
      <p
        className={cn(
          "min-w-0 flex-1",
          amber ? "text-warning" : "text-muted-foreground",
        )}
      >
        {leadsWithName ? (
          <>
            <span className="font-medium text-foreground">{bot.name}</span>
            {line.text.slice(bot.name.length)}
          </>
        ) : (
          line.text
        )}
      </p>
      <LineAction line={line} />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <IconX />
      </Button>
    </div>
  );
}
