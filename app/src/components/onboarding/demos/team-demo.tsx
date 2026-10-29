import { useQuery } from "@tanstack/react-query";
import { BotOrb } from "@/components/agents/orb/bot-orb";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { cn } from "@/lib/utils";
import { DemoStage } from "../demo-stage";

/** What a card needs. Examples carry these and nothing more. */
type TeamCard = Pick<AgentProfile, "id" | "name" | "avatarSeed"> & {
  /** What it does, in a few words. */
  role: string;
  /** Invented, to show what a team looks like: dimmed and labelled, never read as a Bot here. */
  example?: boolean;
};

/**
 * Stand-ins for a deployment with fewer than three public Bots to show. Invented names on purpose:
 * they illustrate a team without claiming any of these exist here. Their seeds are picked to draw
 * three different colours: berry, ocean and coral.
 */
const EXAMPLES: TeamCard[] = [
  {
    id: "example-research",
    name: "Research Analyst",
    avatarSeed: "example-research",
    role: "Finds and compares",
  },
  {
    id: "example-data",
    name: "Data Analyst",
    avatarSeed: "data-analyst",
    role: "Reads the numbers",
  },
  {
    id: "example-support",
    name: "Support Desk",
    avatarSeed: "example-support-agent",
    role: "Answers customers",
  },
];

/** The Bots a team card shows: real public Bots first, examples topping up a sparse deployment. */
export function teamCards(agents: AgentProfile[] | undefined): TeamCard[] {
  const shared =
    agents?.filter((agent) => !agent.mine && agent.visibility === "public") ??
    [];
  return [
    ...shared.slice(0, 3).map((agent) => ({
      id: agent.id,
      name: agent.name,
      avatarSeed: agent.avatarSeed,
      role: agent.title,
    })),
    // Slicing past the end is [], so three or more real Bots take no examples at all.
    ...EXAMPLES.slice(shared.length).map((example) => ({
      ...example,
      example: true,
    })),
  ];
}

/**
 * Your team of Bots: three Bots, each its own orb in its own colour, and a place for one of yours.
 * One at a time, a Bot picks something up and works on it, so the cards read as a team.
 */
export function TeamDemo() {
  const { data: agents } = useQuery(agentListQueryOptions());
  const cards = teamCards(agents);
  return (
    <DemoStage
      beats={cards.length}
      className="flex flex-col gap-2.5 p-4 sm:p-6"
      kind="team"
      label={`Bots you can work with: ${cards
        .map(
          (card) => `${card.name} (${card.example ? "example" : "available"})`,
        )
        .join(", ")}, and one of your own`}
      rest={-1}
    >
      {({ beat, playing }) => (
        <>
          {cards.map((card, at) => {
            const working = at === beat;
            return (
              <div
                className={cn(
                  "flex min-w-0 items-center gap-3 rounded-xl bg-card p-3 shadow-(--shadow-card)",
                  card.example && "opacity-75",
                )}
                data-team-card={card.id}
                data-working={working ? "" : undefined}
                key={card.id}
              >
                <span className="inline-flex shrink-0 overflow-hidden rounded-full">
                  <BotOrb
                    seed={card.avatarSeed}
                    size={44}
                    state={working ? "thinking" : "idle"}
                    still={!playing}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="type-sub truncate font-medium">{card.name}</p>
                  <p className="type-caption truncate text-muted-foreground">
                    {card.example ? "Example" : card.role || "Ready"}
                  </p>
                </div>
                <span
                  className={cn(
                    "type-caption flex shrink-0 items-center gap-1 text-status-working transition-opacity duration-300",
                    working ? "opacity-100" : "opacity-0",
                  )}
                >
                  <span className="size-1.5 rounded-full bg-status-working" />
                  Working
                </span>
              </div>
            );
          })}
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-dashed border-foreground/25 p-3">
            <span className="size-11 shrink-0 rounded-full border border-dashed border-foreground/30" />
            <p className="type-sub truncate font-medium text-foreground/70">
              Your own Bot
            </p>
          </div>
        </>
      )}
    </DemoStage>
  );
}
