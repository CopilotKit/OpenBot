import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  learningDeliveryQueryOptions,
  learningKeys,
  learningOverviewQueryOptions,
  learningSettingsQueryOptions,
  saveLearningSettings,
} from "@/lib/learning/queries";
import type {
  LearningSettings,
  LearningTarget,
} from "../../../../../shared/learning";

export const Route = createFileRoute("/_authed/admin/learning")({
  component: LearningPage,
});
const selectClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";

function TargetFields({
  target,
  onChange,
  label,
}: {
  target: LearningTarget | null;
  onChange: (target: LearningTarget | null) => void;
  label: string;
}) {
  const fieldId = useId();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-2 text-sm" htmlFor={`${fieldId}-container`}>
        {label} container ID
        <Input
          id={`${fieldId}-container`}
          aria-label={`${label} container ID`}
          value={target?.containerId ?? ""}
          maxLength={64}
          placeholder="support-learning"
          onChange={(event) =>
            onChange(
              event.target.value
                ? { ...target, containerId: event.target.value }
                : null,
            )
          }
        />
      </label>
      <label className="grid gap-2 text-sm" htmlFor={`${fieldId}-revision`}>
        Exact revision (optional)
        <Input
          id={`${fieldId}-revision`}
          aria-label={`${label} revision`}
          value={target?.revision ?? ""}
          disabled={!target}
          placeholder="Latest published"
          maxLength={256}
          onChange={(event) => {
            if (target)
              onChange({
                containerId: target.containerId,
                ...(event.target.value ? { revision: event.target.value } : {}),
              });
          }}
        />
      </label>
    </div>
  );
}

export function LearningPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(learningSettingsQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const roster = [...(agents.data ?? []), ...(hiddenAgents.data ?? [])];
  const [draft, setDraft] = useState<LearningSettings | null>(null);
  const [selected, setSelected] = useState("");
  const [saved, setSaved] = useState(false);
  const overview = useQuery(
    learningOverviewQueryOptions(selected || undefined),
  );
  const delivery = useQuery(learningDeliveryQueryOptions(selected));
  const settings = draft ?? settingsQuery.data;
  const save = useMutation({
    mutationFn: saveLearningSettings,
    onSuccess: async (next) => {
      queryClient.setQueryData(learningKeys.settings, next);
      setDraft(null);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: learningKeys.all });
    },
  });
  function change(next: LearningSettings) {
    setDraft(next);
    setSaved(false);
    save.reset();
  }
  const botIds = [
    ...new Set([
      ...roster.map((agent) => agent.id),
      ...Object.keys(settings?.agents ?? {}),
    ]),
  ];
  const nameFor = (id: string) =>
    roster.find((agent) => agent.id === id)?.name ?? id;
  const snapshot = overview.data;

  return (
    <PageShell
      title="Automatic Learning"
      description="Collect completed conversations as evidence, review the skills Intelligence proposes, and deliver published guidance to Bots."
    >
      <PageSection
        title="Participation"
        description="Changes to container assignments apply to new threads. Existing threads keep their first assignment. Containers must already exist in the same Intelligence project."
      >
        {settingsQuery.isPending && (
          <p role="status">Loading Learning settings…</p>
        )}
        {settingsQuery.error && (
          <p role="alert" className="text-destructive">
            {settingsQuery.error.message}
          </p>
        )}
        {settings && (
          <form
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(settings);
            }}
          >
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(event) =>
                  change({ ...settings, enabled: event.target.checked })
                }
              />
              Enable Automatic Learning and skill delivery
            </label>
            <TargetFields
              label="Default"
              target={settings.defaultTarget}
              onChange={(defaultTarget) =>
                change({ ...settings, defaultTarget })
              }
            />
            <p className="text-muted-foreground text-sm">
              An empty default leaves unmapped Bots out. IDs use 1–64 lowercase
              letters, numbers, and single hyphens. Leave revision empty to
              follow the latest published skills.
            </p>
            <fieldset className="grid gap-4">
              <legend className="mb-3 font-medium">
                Per-Bot participation
              </legend>
              {(agents.error || hiddenAgents.error) && (
                <p role="alert" className="text-destructive">
                  The Bot list could not be loaded. Existing mappings are shown
                  below.
                </p>
              )}
              {botIds.map((id) => {
                const override = settings.agents[id];
                const mode = !Object.hasOwn(settings.agents, id)
                  ? "inherit"
                  : override === null
                    ? "exclude"
                    : "container";
                return (
                  <div key={id} className="grid gap-3 rounded-lg border p-4">
                    <label className="grid gap-2 text-sm font-medium">
                      {nameFor(id)}
                      <select
                        className={selectClass}
                        aria-label={`${nameFor(id)} participation`}
                        value={mode}
                        onChange={(event) => {
                          const mappings = { ...settings.agents };
                          if (event.target.value === "inherit")
                            delete mappings[id];
                          else
                            mappings[id] =
                              event.target.value === "exclude"
                                ? null
                                : {
                                    containerId:
                                      settings.defaultTarget?.containerId ?? "",
                                  };
                          change({ ...settings, agents: mappings });
                        }}
                      >
                        <option value="inherit">Use deployment default</option>
                        <option value="exclude">Exclude from Learning</option>
                        <option value="container">
                          Use a specific container
                        </option>
                      </select>
                    </label>
                    {mode === "container" && (
                      <TargetFields
                        label={nameFor(id)}
                        target={override ?? null}
                        onChange={(target) =>
                          change({
                            ...settings,
                            agents: {
                              ...settings.agents,
                              [id]: target ?? { containerId: "" },
                            },
                          })
                        }
                      />
                    )}
                  </div>
                );
              })}
            </fieldset>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save Learning settings"}
              </Button>
              {saved && (
                <p role="status" className="text-sm">
                  Settings saved.
                </p>
              )}
            </div>
            {save.error && (
              <p role="alert" className="text-destructive">
                {save.error.message}
              </p>
            )}
          </form>
        )}
      </PageSection>
      <PageSection
        title="Review and publish"
        description="Intelligence analyzes completed runs and proposes skills. Review their supporting evidence and publish approved revisions in Intelligence before Bots can use them."
      >
        <div className="grid gap-4">
          <label className="grid gap-2 text-sm">
            Inspect container for
            <select
              className={selectClass}
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">Deployment default</option>
              {botIds.map((id) => (
                <option key={id} value={id}>
                  {nameFor(id)}
                </option>
              ))}
            </select>
          </label>
          {overview.isPending && <p role="status">Checking Intelligence…</p>}
          {overview.error && (
            <p role="alert" className="text-destructive">
              {overview.error.message}
            </p>
          )}
          {snapshot && (
            <>
              <p className="text-sm">
                {snapshot.configuration === "configured"
                  ? `${snapshot.container?.name} (${snapshot.container?.id})`
                  : snapshot.configuration === "invalid"
                    ? "The selected container or instrumentation is unavailable."
                    : snapshot.configuration === "selection_required"
                      ? "Select a Bot or configure a default container."
                      : "No Learning container is assigned."}
              </p>
              <dl className="grid grid-cols-2 gap-4 rounded-lg border p-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">Threads ready</dt>
                  <dd className="font-semibold text-xl">
                    {snapshot.pendingThreadCount}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    Candidates to review
                  </dt>
                  <dd className="font-semibold text-xl">
                    {snapshot.pendingCandidateCount}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Published skills</dt>
                  <dd className="font-semibold text-xl">
                    {snapshot.publishedSkillCount}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Insights</dt>
                  <dd className="font-semibold text-xl">
                    {snapshot.insightCount}
                  </dd>
                </div>
              </dl>
              <p className="text-sm">
                {snapshot.hasActiveRun
                  ? "An analysis is running."
                  : snapshot.latestRunStatus
                    ? `Latest analysis: ${snapshot.latestRunStatus}.`
                    : "No analysis has run yet."}
              </p>
              <div className="flex flex-wrap gap-4 text-sm underline">
                <a
                  href={snapshot.links.learning}
                  target="_blank"
                  rel="noreferrer"
                >
                  Manage Learning in Intelligence
                </a>
                {snapshot.links.candidates && (
                  <a
                    href={snapshot.links.candidates}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Review skill candidates
                  </a>
                )}
                {snapshot.links.runs && (
                  <a
                    href={snapshot.links.runs}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View analysis runs
                  </a>
                )}
              </div>
            </>
          )}
          {selected && (
            <div className="grid gap-2 rounded-lg border p-4 text-sm">
              <h3 className="font-medium">Skill delivery</h3>
              {delivery.isPending ? (
                <p>Checking delivery…</p>
              ) : delivery.error ? (
                <p role="alert">{delivery.error.message}</p>
              ) : (
                delivery.data && (
                  <>
                    <p>
                      {!delivery.data.configured
                        ? "Delivery is off for this Bot."
                        : !delivery.data.initialized
                          ? "Waiting for the first verified skill snapshot."
                          : delivery.data.stale
                            ? "Using the last verified snapshot; refresh is pending."
                            : "A verified snapshot is available."}
                    </p>
                    {delivery.data.revision && (
                      <p>Loaded revision: {delivery.data.revision}</p>
                    )}
                    {delivery.data.lastCheckedAt && (
                      <p>
                        Last checked:{" "}
                        {new Date(delivery.data.lastCheckedAt).toLocaleString()}
                      </p>
                    )}
                    {delivery.data.error && (
                      <p role="alert">{delivery.data.error.message}</p>
                    )}
                  </>
                )
              )}
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={overview.isFetching || delivery.isFetching}
            onClick={() => {
              void overview.refetch();
              if (selected) void delivery.refetch();
            }}
          >
            Refresh status
          </Button>
          <p className="text-muted-foreground text-sm">
            Management requires your Intelligence account and project
            permissions. OpenBot keeps project credentials on the server.
            Pausing here preserves settings and thread assignments; schedules
            and publication remain managed in Intelligence.
          </p>
        </div>
      </PageSection>
    </PageShell>
  );
}
