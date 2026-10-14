import {
  IconArrowUpRight,
  IconBook2,
  IconCode,
  IconSparkles,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AgentCard } from "@/components/agents/agent-card";
import {
  Composer,
  toAgentOptions,
  toDocumentOptions,
} from "@/components/channels/composer";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { agentListQueryOptions, isSharedWithYou } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { routeMessage } from "@/lib/channels/route";
import { useStartChannel } from "@/lib/channels/start";
import { documentsQueryOptions } from "@/lib/documents/queries";

export const Route = createFileRoute("/_authed/_app/")({
  component: AgentForceHome,
});

const SUGGESTIONS = [
  {
    agentId: "knowledge",
    icon: IconBook2,
    label: "What's our annual leave policy?",
    eyebrow: "Company knowledge",
  },
  {
    agentId: "developer",
    icon: IconCode,
    label: "Implement Linear ticket ORC-424",
    eyebrow: "Product Engineer",
  },
  {
    agentId: "general-assistant",
    icon: IconSparkles,
    label: "Research the latest React updates",
    eyebrow: "Research",
  },
] as const;

const FEATURED_AGENT_IDS = ["general-assistant", "knowledge", "developer"];

function AgentForceHome() {
  const {
    data: agents,
    isPending: loading,
    isError: failed,
  } = useQuery(agentListQueryOptions());
  const { data: knowledgeDocuments } = useQuery(documentsQueryOptions());
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const { start, startChosen, pending } = useStartChannel();
  const [error, setError] = useState<string | null>(null);
  const fallback = defaultAgentProfile(
    agents,
    agents?.find((agent) => agent.visibility === "public"),
  );
  const featured =
    agents?.filter((agent) => FEATURED_AGENT_IDS.includes(agent.id)) ?? [];
  const explore = agents?.filter(isSharedWithYou);
  const firstName =
    currentUser?.name?.trim().split(/\s+/)[0] ??
    currentUser?.email?.split("@")[0] ??
    "Kehinde";
  const greeting =
    new Date().getHours() < 12 ? "Good morning" : "Good afternoon";

  const launchPrompt = async (agentId: string, text: string) => {
    setError(null);
    try {
      const available = agents?.some((agent) => agent.id === agentId);
      if (available) {
        await startChosen(agentId, text);
        return;
      }
      if (fallback) await start(fallback.id, text);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not start this task.",
      );
    }
  };

  return (
    <>
      <SidebarToggleBar />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col px-5 pb-14 pt-8 sm:px-8 sm:pt-14">
          <div className="agentforce-hero relative overflow-hidden rounded-[1.75rem] bg-primary px-6 py-10 text-primary-foreground shadow-sm sm:px-10 sm:py-12">
            <div className="pointer-events-none absolute -right-16 -top-24 size-72 rounded-full border border-white/10" />
            <div className="pointer-events-none absolute -right-3 top-10 size-36 rounded-full border border-[#d4a853]/25" />
            <div className="relative max-w-3xl">
              <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-[#d4a853]">
                Your team's AI workforce
              </p>
              <h1 className="font-heading text-4xl leading-none tracking-tight sm:text-5xl">
                {greeting}, {firstName}.
              </h1>
              <p className="mt-3 text-base text-white/65">
                What would you like to get done?
              </p>
              <div className="mt-8 rounded-2xl border border-white/15 bg-white p-2 text-foreground shadow-2xl shadow-black/10">
                <Composer
                  agents={toAgentOptions(agents)}
                  documents={toDocumentOptions(knowledgeDocuments)}
                  className="w-full"
                  disabled={!fallback}
                  onSubmit={async (draft) => {
                    setError(null);
                    try {
                      if (draft.agentId) {
                        await startChosen(
                          draft.agentId,
                          draft.text,
                          draft.documentIds,
                        );
                        return;
                      }
                      let agentId: string | undefined;
                      try {
                        agentId = (await routeMessage(draft.text)).agentId;
                      } catch {
                        agentId = fallback?.id;
                      }
                      if (agentId) {
                        await start(agentId, draft.text, draft.documentIds);
                      }
                    } catch (caught) {
                      setError(
                        caught instanceof Error
                          ? caught.message
                          : "Could not start this task.",
                      );
                      throw caught;
                    }
                  }}
                  pending={pending}
                />
              </div>
              {fallback ? (
                <p className="mt-3 text-xs text-white/45">
                  Sent to the coworker it is for. Type <code>@</code> to choose
                  one yourself, or <code>#</code> to attach a document.
                </p>
              ) : null}
              {error ? (
                <p className="mt-3 text-sm text-red-200" role="alert">
                  {error}
                </p>
              ) : failed && agents === undefined ? (
                // `agents === undefined` is the only condition that means the query has never
                // once returned, so this can never claim a failure while a retained roster is
                // still driving an enabled composer beside it.
                <p className="mt-3 text-sm text-red-200" role="alert">
                  Your coworkers couldn't be loaded, so there's no one to send
                  this to yet.
                </p>
              ) : null}
            </div>
          </div>

          <section className="mt-9">
            <h2 className="text-sm font-semibold text-foreground">
              Try asking
            </h2>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  className="group rounded-xl border bg-card p-4 text-left transition hover:-translate-y-0.5 hover:border-[#d4a853]/60 hover:shadow-md disabled:pointer-events-none disabled:opacity-50"
                  disabled={pending}
                  key={suggestion.label}
                  onClick={() =>
                    launchPrompt(suggestion.agentId, suggestion.label)
                  }
                  type="button"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                      <suggestion.icon className="size-4" />
                    </div>
                    <IconArrowUpRight className="size-4 text-muted-foreground transition group-hover:text-foreground" />
                  </div>
                  <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {suggestion.eyebrow}
                  </p>
                  <p className="mt-1 text-sm font-medium">{suggestion.label}</p>
                </button>
              ))}
            </div>
          </section>

          <section className="mt-10">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">
                Your agents
              </h2>
              <Button
                size="sm"
                variant="ghost"
                render={(props) => <Link {...props} to="/agents" />}
              >
                View all
                <IconArrowUpRight />
              </Button>
            </div>
            <div className="mt-3 overflow-hidden rounded-xl border bg-card">
              {featured.map((agent) => (
                <Link
                  className="flex items-center gap-4 border-border border-b px-4 py-3.5 transition last:border-b-0 hover:bg-muted/55"
                  key={agent.id}
                  search={{ agent: agent.id }}
                  to="/channel/new"
                >
                  <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground">
                    {agent.name
                      .split(/\s+/)
                      .slice(0, 2)
                      .map((part) => part[0])
                      .join("")}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{agent.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {agent.title}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-2 text-xs font-medium text-emerald-700">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    Ready
                  </span>
                </Link>
              ))}
              {!agents ? (
                <div className="p-5 text-sm text-muted-foreground">
                  Loading your agents…
                </div>
              ) : null}
            </div>
          </section>

          {/*
           * Agents somebody else shared, kept separate from the three above because these are a
           * fact about this workspace rather than part of the demo script. Each arm reserves the
           * same height so the page does not move when the query settles or fails.
           */}
          <section className="mt-10">
            {loading ? (
              <>
                <h2 className="font-bold text-lg">Explore agents</h2>
                <Skeleton className="mt-4 h-[180px]" />
              </>
            ) : explore?.length ? (
              // Wins over `failed`: a failed background refetch keeps the cached roster, and a
              // stale list here beats an error card claiming there is nothing to explore.
              <>
                <h2 className="font-bold text-lg">Explore agents</h2>
                <div className="mt-4 flex flex-row flex-wrap gap-4">
                  {explore.map((agent) => (
                    <Link
                      key={agent.id}
                      search={{ agent: agent.id }}
                      to="/channel/new"
                    >
                      <AgentCard agent={agent} />
                    </Link>
                  ))}
                </div>
              </>
            ) : failed && agents === undefined ? (
              <>
                <h2 className="font-bold text-lg">Explore agents</h2>
                <Empty className="mt-4 h-[180px] border border-dashed border-destructive">
                  <EmptyHeader>
                    <EmptyTitle className="text-destructive">
                      Agents shared with you couldn't be loaded.
                    </EmptyTitle>
                  </EmptyHeader>
                </Empty>
              </>
            ) : (
              // Reached when the slice loaded and is genuinely empty, including after a failed
              // refetch that left `agents` defined. An empty roster is a fact, not an error.
              <>
                <h2 className="font-bold text-lg">Explore agents</h2>
                <Empty className="mt-4 h-[180px] border border-dashed">
                  <EmptyHeader>
                    <EmptyTitle className="text-muted-foreground">
                      Nobody has shared an agent with you yet.
                    </EmptyTitle>
                  </EmptyHeader>
                </Empty>
              </>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
