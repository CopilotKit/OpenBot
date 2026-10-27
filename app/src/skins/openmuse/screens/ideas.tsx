import { IconBulb, IconExternalLink, IconRefresh } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  changeProactiveSettingMutationOptions,
  type ProactiveSuggestion,
  proactiveSettingsQueryOptions,
  proactiveSuggestionsQueryOptions,
  resolveSuggestionMutationOptions,
} from "@/lib/proactive";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { useMuse } from "../context";
import { ideaEmoji } from "../model";
import {
  ErrorNotice,
  MuseButton,
  MuseEmpty,
  MuseLinkButton,
  MuseScreen,
  museText,
} from "../ui";

/**
 * Ideas: the next steps the centre Bot's background research proposed, from OpenBot's suggestions.
 * Each keeps OpenBot's two actions — start it as a task, or dismiss it — and "Find ideas" runs the
 * Bot's research now, as the Run control on its OpenBot page does.
 */
export function IdeasScreen() {
  const { bot } = useMuse();
  const suggestions = useQuery(proactiveSuggestionsQueryOptions());
  const settings = useQuery(proactiveSettingsQueryOptions());
  const change = useMutation(
    changeProactiveSettingMutationOptions(queryClient),
  );
  const research = (settings.data ?? []).filter(
    (setting) => setting.agentId === bot?.id,
  );
  const runnable = research.filter((setting) => setting.enabled);
  const running = research.some((setting) => setting.lastStatus === "running");
  const ideas = (suggestions.data ?? []).filter(
    (suggestion) => suggestion.agentId === bot?.id,
  );

  return (
    <MuseScreen title="Ideas">
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-3">
          <p className={museText.small}>
            {settings.isPending
              ? ""
              : runnable.length
                ? "Inspired by your connected apps"
                : `Background research is off for ${bot?.name ?? "this Bot"}`}
          </p>
          {runnable.length ? (
            <MuseButton
              disabled={change.isPending || running}
              icon={IconRefresh}
              onClick={() => {
                for (const setting of runnable) {
                  change.mutate({ setting, change: { kind: "run" } });
                }
              }}
              small
            >
              {running ? "Looking…" : "Find ideas"}
            </MuseButton>
          ) : bot && !settings.isPending ? (
            <MuseLinkButton
              render={
                <Link params={{ agentId: bot.id }} to="/bots/$agentId/memory" />
              }
              small
            >
              Turn it on
            </MuseLinkButton>
          ) : null}
        </div>
        <ErrorNotice error={change.error?.message} />
        {suggestions.isPending ? null : suggestions.error ? (
          <ErrorNotice error={suggestions.error.message} />
        ) : ideas.length === 0 ? (
          <MuseEmpty
            detail={`${bot?.name ?? "Your Bot"} suggests next steps here from the apps it can read, and says where each one came from.`}
            icon={IconBulb}
            title="Room for a good idea"
          />
        ) : (
          <div>
            {ideas.map((idea) => (
              <IdeaRow
                channelId={
                  research.find((setting) => setting.agentId === idea.agentId)
                    ?.channelId
                }
                idea={idea}
                key={idea.id}
              />
            ))}
          </div>
        )}
      </div>
    </MuseScreen>
  );
}

function IdeaRow({
  idea,
  channelId,
}: {
  idea: ProactiveSuggestion;
  /** Where the Bot's research reports, and so where a started idea runs. */
  channelId: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const act = useMutation(resolveSuggestionMutationOptions(queryClient));
  const navigate = useNavigate();
  const [lead, ...rest] = idea.detail.trim().split(/\n+/);
  return (
    <div className="border-border border-b py-[18px]">
      <button
        aria-expanded={expanded}
        aria-label={`View idea: ${idea.title}`}
        className="flex w-full gap-3.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span
          aria-hidden="true"
          className="w-[34px] shrink-0 pt-[3px] text-[27px] leading-none"
        >
          {ideaEmoji(idea.title)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
          <span className={cn(museText.heading, "leading-[23px]")}>
            {idea.title}
          </span>
          {lead ? (
            <span className={cn(museText.muted, !expanded && "line-clamp-2")}>
              {lead}
            </span>
          ) : null}
        </span>
      </button>
      {expanded ? (
        <div className="mt-[18px] flex flex-col gap-[15px] pl-12">
          {rest.length || idea.sourceApp || idea.sourceLink ? (
            <div className="flex flex-col gap-1 border-[var(--openmuse-blue)] border-l-2 pl-3">
              <p className="font-semibold text-[11px] text-foreground leading-[17px]">
                {idea.sourceApp
                  ? `From ${idea.sourceApp}`
                  : "From a connected app"}
                {` · ${new Date(idea.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
              </p>
              {rest.length ? (
                <p className={cn(museText.small, "whitespace-pre-wrap")}>
                  {rest.join("\n")}
                </p>
              ) : null}
              {idea.sourceLink ? (
                <MuseLinkButton
                  className="mt-1 self-start"
                  icon={IconExternalLink}
                  render={
                    <a
                      href={idea.sourceLink}
                      rel="noreferrer"
                      target="_blank"
                    />
                  }
                  small
                >
                  Open source
                </MuseLinkButton>
              ) : null}
            </div>
          ) : null}
          <ErrorNotice error={act.error?.message} />
          <div className="flex flex-wrap gap-2">
            <MuseButton
              disabled={act.isPending}
              onClick={() =>
                act.mutate(
                  { id: idea.id, action: "start" },
                  {
                    // A started idea runs as a turn in the channel the research reports to.
                    onSuccess: () => {
                      if (channelId)
                        void navigate({
                          to: "/channel/$channelId",
                          params: { channelId },
                        });
                    },
                  },
                )
              }
              primary
            >
              Start this
            </MuseButton>
            <MuseButton
              disabled={act.isPending}
              onClick={() => act.mutate({ id: idea.id, action: "dismiss" })}
            >
              Dismiss
            </MuseButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}
