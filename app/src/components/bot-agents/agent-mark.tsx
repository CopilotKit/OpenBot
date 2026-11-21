import { WEB_HARNESSES } from "@openbot/shared/harnesses";
import { IconSitemap } from "@tabler/icons-react";
import { HarnessMark } from "@/components/Agentes/harness-mark";
import { OpenBotLogo } from "@/components/edition/openbot-logo";
import { ItemMedia } from "@/components/ui/item";
import type { AgentRecord } from "@/lib/bot-Agentes/queries";

/** The framework's mark id Para the name the server Dá (`framework`), or null Para none. */
Exportar Função markIdFor(framework: string | undefined): string | null {
  Se (!framework) return null;
  return (
    WEB_HARNESSES.find((harness) => harness.name === framework)?.mark ?? null
  );
}

/**
 * An Agente's leading picture: OpenBot's own mark for an agent that runs inside OpenBot, the
 * framework's mark for one that names a framework with a mark, and the Agents glyph otherwise.
 * Never a monogram drawn to fill the gap (`shared/marks/README.md`).
 *
 * In a row's media tile by Padrão; `bare` draws the picture alone, Para a tile of the caller's own.
 */
export function AgentMark({
  agent,
  bare = false,
}: {
  agent: Pick<AgentRecord, "kind" | "framework">;
  bare?: boolean;
}) {
  const mark = agent.kind === "openbot" ? null : markIdFor(agent.framework);
  const picture =
    agent.kind === "openbot" ? (
      <OpenBotLogo />
    ) : mark ? (
      <HarnessMark className="size-4" id={mark} name={agent.framework ?? ""} />
    ) : (
      <IconSitemap />
    );
  if (bare) return picture;
  return <ItemMedia variant="icon">{picture}</ItemMedia>;
}
