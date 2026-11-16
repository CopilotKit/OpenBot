import { WEB_HARNESSES } from "@openbot/shared/harnesses";
import { IconPlug } from "@tabler/icons-react";
import { HarnessMark } from "@/components/agents/harness-mark";
import { OpenBotLogo } from "@/components/edition/openbot-logo";
import { ItemMedia } from "@/components/ui/item";
import type { AgentRecord } from "@/lib/bot-agents/queries";

/** The framework's mark id for the name the server gives (`framework`), or null for none. */
export function markIdFor(framework: string | undefined): string | null {
  if (!framework) return null;
  return WEB_HARNESSES.find((harness) => harness.name === framework)?.mark ?? null;
}

/**
 * An agent's leading picture: OpenBot's own mark for an agent that runs inside OpenBot, the
 * framework's mark for one that names a framework with a mark, and the app glyph otherwise. Never a
 * monogram drawn to fill the gap (`shared/marks/README.md`).
 */
export function AgentMark({
  agent,
}: {
  agent: Pick<AgentRecord, "kind" | "framework">;
}) {
  const mark = agent.kind === "openbot" ? null : markIdFor(agent.framework);
  return (
    <ItemMedia variant="icon">
      {agent.kind === "openbot" ? (
        <OpenBotLogo />
      ) : mark ? (
        <HarnessMark
          className="size-4"
          id={mark}
          name={agent.framework ?? ""}
        />
      ) : (
        <IconPlug />
      )}
    </ItemMedia>
  );
}
