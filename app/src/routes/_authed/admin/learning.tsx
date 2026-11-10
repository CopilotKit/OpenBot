import type {
  LearningAutoAssignState,
  LearningProposal,
  LearningRunSummary,
  LearningSettings,
  LearningTarget,
} from "@openbot/shared/learning";
import {
  IconChevronRight,
  IconHistory,
  IconSparkles,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useId, useState } from "react";
import {
  PeopleProposalsSection,
  SharingRequestsSection,
  WhoApprovesSection,
} from "@/components/admin/controls/people-learning";
import { SkillSharingSection } from "@/components/admin/controls/skill-sharing-section";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { LearnedSkillDialog } from "@/components/learning/learned-skill-dialog";
import { ProposalDialog } from "@/components/learning/proposal-dialog";
import { skillTitle } from "@/lib/learning/display";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  reviewLearningProposalMutationOptions,
  startLearningRunMutationOptions,
} from "@/lib/learning/mutations";
import {
  createLearningContainer,
  learnedSkillsQueryOptions,
  learningAutomaticQueryOptions,
  learningDeliveryQueryOptions,
  learningKeys,
  learningOverviewQueryOptions,
  learningProposalQueryOptions,
  learningProposalsQueryOptions,
  learningRunsQueryOptions,
  learningSettingsQueryOptions,
  saveLearningSettings,
} from "@/lib/learning/queries";
import { queryClient as appQueryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/learning")({
  component: LearningPage,
});
const selectClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";

/** What automatic assignment found, in words, or nothing when there is nothing to say. */
function automaticMessage(
  automatic: LearningAutoAssignState | null | undefined,
  settings: LearningSettings,
): string | undefined {
  if (!automatic) return undefined;
  if (
    automatic.state === "assigned" &&
    settings.defaultTarget?.containerId === automatic.containerId
  )
    return `OpenBot assigned this project's "${automatic.containerId}" container automatically. You can change it here.`;
  if (automatic.state === "absent")
    return `This project has no "${automatic.containerId}" Learning container yet. Nothing is collected.`;
  if (automatic.state === "not_entitled")
    return "This project's plan doesn't include Learning. No container was assigned.";
  if (automatic.state === "learning_off")
    return "Learning is switched off in the backend. Nothing is collected until it's turned on there.";
  if (automatic.state === "unavailable")
    return "Couldn't reach the backend to find this project's Learning container. OpenBot will try again.";
  return undefined;
}

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

/**
 * The missing container, and how it gets made: a button when this deployment holds a credential that
 * can create it, and always the exact steps for an operator, since the runtime key cannot.
 */
function ContainerSetup({
  automatic,
}: {
  automatic: Extract<LearningAutoAssignState, { state: "absent" }>;
}) {
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: createLearningContainer,
    onSuccess: async (next) => {
      queryClient.setQueryData(learningKeys.automatic, next);
      await queryClient.invalidateQueries({ queryKey: learningKeys.all });
    },
  });
  return (
    <div className="grid gap-2 rounded-md border p-3 text-sm">
      {automatic.canCreate && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending
              ? "Creating…"
              : `Create the ${automatic.containerId} container`}
          </Button>
          <span className="text-muted-foreground">
            Uses this deployment's backend credentials.
          </span>
        </div>
      )}
      {(create.error || automatic.createError) && (
        <p role="alert" className="text-destructive">
          {create.error?.message ?? automatic.createError}
        </p>
      )}
      {automatic.instructions && (
        <p>
          <span className="font-medium">To create it: </span>
          {automatic.instructions}
        </p>
      )}
    </div>
  );
}

/**
 * Who approves is saved from its own dialog. A Participation draft copied the
 * whole object earlier, so sending those two keys back would overwrite a
 * newer choice; PUT /settings keeps the stored value when they are omitted.
 */
function withoutReviewKeys(settings: LearningSettings): LearningSettings {
  const { personalReview: _review, autoApprove: _auto, ...rest } = settings;
  return rest;
}

export function LearningPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(learningSettingsQueryOptions());
  const automatic = useQuery(learningAutomaticQueryOptions());
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
  // About what is saved, so it steps aside while an edit is in progress.
  const automaticNote =
    settingsQuery.data && !draft
      ? automaticMessage(automatic.data, settingsQuery.data)
      : undefined;
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
      title="Automatic learning"
      description="Learn from finished conversations, review the skills OpenBot proposes, and give published skills to Bots."
    >
      <PageSection
        title="Participation"
        description="Container changes apply to new conversations. Existing ones keep their first container. Containers must already exist in the same project. Until you save here, OpenBot uses that project's openbot container."
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
              save.mutate(withoutReviewKeys(settings));
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
              Turn on automatic learning and skill delivery
            </label>
            <TargetFields
              label="Default"
              target={settings.defaultTarget}
              onChange={(defaultTarget) =>
                change({ ...settings, defaultTarget })
              }
            />
            {automaticNote && (
              <p role="status" className="text-sm">
                {automaticNote}
              </p>
            )}
            {!draft && automatic.data?.state === "absent" && (
              <ContainerSetup automatic={automatic.data} />
            )}
            <p className="text-muted-foreground text-sm">
              With no default, Bots without their own container are left out.
              IDs are 1 to 64 lowercase letters, numbers and single hyphens.
              Leave revision empty to use the latest published skills.
            </p>
            <fieldset className="grid gap-4">
              <legend className="mb-3 font-medium">
                Per-Bot participation
              </legend>
              {(agents.error || hiddenAgents.error) && (
                <p role="alert" className="text-destructive">
                  Couldn't load the Bot list. Saved settings for each Bot are
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
                        <option value="exclude">Leave out of Learning</option>
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
            <div className="flex items-center justify-end gap-3">
              {saved && (
                <p role="status" className="text-sm">
                  Settings saved.
                </p>
              )}
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save Learning settings"}
              </Button>
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
        description="OpenBot studies finished conversations and proposes skills. Review and publish them below. Bots only use published skills."
      >
        <div className="grid gap-4">
          <label className="grid gap-2 text-sm">
            Show the container for
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
          {overview.isPending && <p role="status">Checking the backend…</p>}
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
                    ? "The selected container or its instrumentation isn't available."
                    : snapshot.configuration === "selection_required"
                      ? "Choose a Bot, or set a default container."
                      : "No Learning container is assigned."}
              </p>
              {snapshot.modelProblem && (
                <p role="alert" className="text-destructive text-sm">
                  {snapshot.modelProblem}
                </p>
              )}
              <dl className="grid grid-cols-2 gap-4 rounded-lg border p-4 text-sm">
                {(
                  [
                    ["Threads ready", snapshot.pendingThreadCount],
                    ["Candidates to review", snapshot.pendingCandidateCount],
                    ["Published skills", snapshot.publishedSkillCount],
                    ["Insights", snapshot.insightCount],
                  ] as const
                ).map(([label, count]) =>
                  // An older Intelligence with no dashboard does not count these for a project key.
                  count === null ? null : (
                    <div key={label}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="font-semibold text-xl">{count}</dd>
                    </div>
                  ),
                )}
              </dl>
              <p className="text-sm">
                {snapshot.hasActiveRun
                  ? "An analysis is running."
                  : snapshot.latestRunStatus
                    ? `Latest analysis: ${snapshot.latestRunStatus}.`
                    : "No analysis has run yet."}
              </p>
              {/* Links into Intelligence's dashboard, where there is one to link to. */}
              {(snapshot.links.learning || snapshot.links.candidates) && (
                <div className="flex flex-wrap gap-4 text-sm underline">
                  {snapshot.links.learning && (
                    <a
                      href={snapshot.links.learning}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Manage Learning in the backend dashboard
                    </a>
                  )}
                  {snapshot.links.candidates && (
                    <a
                      href={snapshot.links.candidates}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Review skill candidates
                    </a>
                  )}
                </div>
              )}
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
                            ? "Using the last verified snapshot. A refresh is pending."
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
              // The sections below read the same container, and a run only moves on when read again.
              for (const key of [
                learningKeys.proposals(selected || undefined),
                learningKeys.runs(selected || undefined),
                learningKeys.skills(selected || undefined),
              ])
                void queryClient.invalidateQueries({ queryKey: key });
            }}
          >
            Refresh status
          </Button>
          <p className="text-muted-foreground text-sm">
            OpenBot keeps project credentials on the server. Turning Learning
            off here keeps settings and conversation assignments. Schedules stay
            in the backend.
          </p>
        </div>
      </PageSection>
      <ProposedSkills agentId={selected || undefined} />
      <AnalysisRuns agentId={selected || undefined} />
      <PublishedSkills agentId={selected || undefined} />
      <WhoApprovesSection />
      <PeopleProposalsSection />
      <SharingRequestsSection />
      <SkillSharingSection />
    </PageShell>
  );
}

const STATUS: Record<LearningProposal["status"], string> = {
  pending_review: "To review",
  approved: "Published",
  rejected: "Rejected",
};

/**
 * The skills Intelligence proposed for the container shown above, to approve (which publishes it to
 * that container's Bots) or reject, and Learn now. Here because a bundled Intelligence has no
 * dashboard of its own to do it in.
 */
function ProposedSkills({ agentId }: { agentId?: string }) {
  const proposals = useQuery(learningProposalsQueryOptions(agentId));
  const learnNow = useMutation(startLearningRunMutationOptions(appQueryClient));
  const review = useMutation(
    reviewLearningProposalMutationOptions(appQueryClient),
  );
  const [open, setOpen] = useState<string | null>(null);
  const containerId = proposals.data?.containerId ?? null;
  return (
    <PageSection
      title="Proposed skills"
      description="Approve a skill to publish it to the Bots that use this container. Each decision is recorded in the audit log."
      action={
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!containerId || learnNow.isPending}
          onClick={() => learnNow.mutate(agentId)}
        >
          {learnNow.isPending ? "Starting…" : "Learn now"}
        </Button>
      }
    >
      {learnNow.isSuccess && (
        <p role="status" className="mt-4 text-sm">
          Learning started. New skills appear here when it finishes.
        </p>
      )}
      {learnNow.error && (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {learnNow.error.message}
        </p>
      )}
      {proposals.isPending ? null : proposals.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {proposals.error.message}
        </p>
      ) : !containerId ? (
        <PageEmpty icon={IconSparkles} title="No container">
          Choose a container under Participation to see the skills OpenBot
          proposes for it.
        </PageEmpty>
      ) : proposals.data.proposals.length === 0 ? (
        <PageEmpty icon={IconSparkles} title="No proposed skills yet">
          OpenBot proposes skills once it has learned from finished
          conversations. Learn now starts it.
        </PageEmpty>
      ) : (
        <PageRows>
          {proposals.data.proposals.map((proposal, index) => (
            <Fragment key={proposal.id}>
              {index > 0 ? <Separator /> : null}
              <Item
                render={
                  <button onClick={() => setOpen(proposal.id)} type="button" />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconSparkles />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {skillTitle(proposal.title, proposal.description)}
                  </ItemTitle>
                  <ItemDescription>{proposal.description}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-sm">
                    {STATUS[proposal.status]}
                  </span>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
      {open && (
        <ProposalDialog
          decided={review.data?.status}
          deciding={review.isPending}
          error={review.error}
          load={learningProposalQueryOptions(open, agentId)}
          onClose={() => {
            setOpen(null);
            review.reset();
          }}
          onDecide={(decision) =>
            review.mutate({
              proposalId: open,
              decision,
              ...(agentId ? { agentId } : {}),
            })
          }
        />
      )}
    </PageSection>
  );
}

const RUN_STATUS: Record<LearningRunSummary["status"], string> = {
  queued: "Queued",
  freezing: "Starting",
  batching: "Analyzing",
  reducing: "Analyzing",
  finalizing: "Finishing",
  succeeded: "Finished",
  failed: "Failed",
};

const FAILURES: Record<string, string> = {
  LEARNING_MODEL_NOT_CONFIGURED:
    "The backend has no model set up for Learning yet.",
  LEARNING_NOT_ENABLED: "Learning isn't turned on in the backend.",
  LEARNING_CONTAINER_NOT_FOUND: "The backend no longer has this container.",
};

/** What an admin reads for a failed run. The code itself stays in the row's title. */
function failureSentence(code: string | null): string {
  return (code && FAILURES[code]) || "The run failed.";
}

const RUN_POLL_MS = 10_000;

/** Re-read the runs every few seconds while one is still going, so Queued does not outlive the run. */
export function runPollInterval(
  runs: Pick<LearningRunSummary, "status">[] | undefined,
): number | false {
  return runs?.some(
    (run) => run.status !== "succeeded" && run.status !== "failed",
  )
    ? RUN_POLL_MS
    : false;
}

/** One line saying how many skills and insights a run produced, for the counts it has. */
function runCounts(run: LearningRunSummary): string | null {
  const counts = [
    run.proposals !== null ? `${run.proposals} proposed` : null,
    run.insights !== null ? `${run.insights} insights` : null,
  ].filter((count) => count !== null);
  return counts.length > 0 ? counts.join(", ") : null;
}

/** The times a run started and finished, as the reader's local time. */
function runTimes(run: LearningRunSummary): string | null {
  const times = [
    run.startedAt
      ? `Started ${new Date(run.startedAt).toLocaleString()}`
      : null,
    run.completedAt
      ? `Finished ${new Date(run.completedAt).toLocaleString()}`
      : null,
  ].filter((time) => time !== null);
  return times.length > 0 ? times.join(". ") : null;
}

/** The analysis runs of the container shown above, newest first, so no dashboard is needed to see one fail. */
function AnalysisRuns({ agentId }: { agentId?: string }) {
  const runs = useQuery({
    ...learningRunsQueryOptions(agentId),
    refetchInterval: (query) => runPollInterval(query.state.data?.runs),
  });
  return (
    <PageSection
      title="Analysis runs"
      description="Each run looks at finished conversations and proposes skills."
    >
      {runs.isPending ? null : runs.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {runs.error.message}
        </p>
      ) : !runs.data.containerId ? (
        <PageEmpty icon={IconHistory} title="No container">
          Choose a container under Participation to see its analysis runs.
        </PageEmpty>
      ) : runs.data.runs.length === 0 ? (
        <PageEmpty icon={IconHistory} title="No analysis runs yet">
          A run appears here once Learning has analyzed conversations.
        </PageEmpty>
      ) : (
        <PageRows>
          {runs.data.runs.map((run, index) => (
            <Fragment key={run.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconHistory />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {RUN_STATUS[run.status]} ·{" "}
                    {run.trigger === "manual" ? "Manual" : "Automatic"}
                  </ItemTitle>
                  {[runTimes(run), runCounts(run)]
                    .filter((line) => line !== null)
                    .map((line) => (
                      <ItemDescription key={line}>{line}</ItemDescription>
                    ))}
                  {run.status === "failed" ? (
                    <ItemDescription title={run.failureCode ?? undefined}>
                      {failureSentence(run.failureCode)}
                    </ItemDescription>
                  ) : null}
                </ItemContent>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}

/** The skills published in the container shown above, each opening to its files. */
function PublishedSkills({ agentId }: { agentId?: string }) {
  const skills = useQuery(learnedSkillsQueryOptions(agentId));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <PageSection
      title="Published skills"
      description="Bots on this container use these skills. Open one to read it."
    >
      {skills.isPending ? null : skills.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {skills.error.message}
        </p>
      ) : !skills.data.containerId ? (
        <PageEmpty icon={IconSparkles} title="No container">
          Choose a container under Participation to see its published skills.
        </PageEmpty>
      ) : skills.data.skills.length === 0 ? (
        <PageEmpty icon={IconSparkles} title="No published skills yet">
          Skills you approve above appear here.
        </PageEmpty>
      ) : (
        <PageRows>
          {skills.data.skills.map((skill, index) => (
            <Fragment key={skill.name}>
              {index > 0 ? <Separator /> : null}
              <Item
                render={
                  <button onClick={() => setOpen(skill.name)} type="button" />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconSparkles />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {skillTitle(skill.name, skill.description)}
                  </ItemTitle>
                  <ItemDescription>{skill.description}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
      <LearnedSkillDialog
        name={open}
        title={(() => {
          // The title its row showed.
          const shown = skills.data?.skills.find(
            (skill) => skill.name === open,
          );
          return shown ? skillTitle(shown.name, shown.description) : undefined;
        })()}
        onClose={() => setOpen(null)}
        source={{ kind: "admin", agentId }}
      />
    </PageSection>
  );
}
