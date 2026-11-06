import type {
  LearningAutoAssignState,
  LearningEvidence,
  LearningProposal,
  LearningSettings,
  LearningTarget,
} from "@openbot/shared/learning";
import { IconChevronRight, IconSparkles } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useId, useState } from "react";
import { Streamdown } from "streamdown";
import { SkillSharingSection } from "@/components/admin/controls/skill-sharing-section";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  learningAutomaticQueryOptions,
  learningDeliveryQueryOptions,
  learningKeys,
  learningOverviewQueryOptions,
  learningProposalQueryOptions,
  learningProposalsQueryOptions,
  learningSettingsQueryOptions,
  saveLearningSettings,
} from "@/lib/learning/queries";
import { markdownComponents } from "@/lib/markdown";
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
    return `OpenBot assigned this Intelligence project's "${automatic.containerId}" container automatically. You can change it here.`;
  if (automatic.state === "absent")
    return `This Intelligence project has no "${automatic.containerId}" Learning container yet. Nothing is collected.`;
  if (automatic.state === "not_entitled")
    return "This Intelligence project's plan doesn't include Learning. No container was assigned.";
  if (automatic.state === "learning_off")
    return "Learning is switched off in Intelligence. Nothing is collected until it's turned on there.";
  if (automatic.state === "unavailable")
    return "Couldn't reach Intelligence to find this project's Learning container. OpenBot will try again.";
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
            Uses this deployment's Intelligence credentials.
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
      description="Learn from finished conversations, review the skills Intelligence proposes, and give published skills to Bots."
    >
      <PageSection
        title="Participation"
        description="Container changes apply to new conversations. Existing ones keep their first container. Containers must already exist in the same Intelligence project. Until you save here, OpenBot uses that project's openbot container."
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
        description="Intelligence studies finished conversations and proposes skills. Review and publish them below. Bots only use published skills."
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
                    ? "The selected container or its instrumentation isn't available."
                    : snapshot.configuration === "selection_required"
                      ? "Choose a Bot, or set a default container."
                      : "No Learning container is assigned."}
              </p>
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
              {(snapshot.links.learning ||
                snapshot.links.candidates ||
                snapshot.links.runs) && (
                <div className="flex flex-wrap gap-4 text-sm underline">
                  {snapshot.links.learning && (
                    <a
                      href={snapshot.links.learning}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Manage Learning in Intelligence
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
            }}
          >
            Refresh status
          </Button>
          <p className="text-muted-foreground text-sm">
            OpenBot keeps project credentials on the server. Turning Learning
            off here keeps settings and conversation assignments. Schedules stay
            in Intelligence.
          </p>
        </div>
      </PageSection>
      <ProposedSkills agentId={selected || undefined} />
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
          Choose a container under Participation to see the skills Intelligence
          proposes for it.
        </PageEmpty>
      ) : proposals.data.proposals.length === 0 ? (
        <PageEmpty icon={IconSparkles} title="No proposed skills yet">
          Intelligence proposes skills once it has learned from finished
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
                  <ItemTitle>{proposal.title}</ItemTitle>
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
          agentId={agentId}
          onClose={() => setOpen(null)}
          proposalId={open}
        />
      )}
    </PageSection>
  );
}

/** SKILL.md without its front matter, whose name and description the dialog's header already shows. */
function skillBody(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

/** What one Insight was learned from: the messages a conversation was cited for, or a recording. */
function EvidenceList({ evidence }: { evidence: LearningEvidence[] | null }) {
  if (evidence === null)
    return (
      <p className="text-muted-foreground text-sm">
        Couldn't load the evidence for this.
      </p>
    );
  return (
    <ul className="grid gap-3">
      {evidence.map((entry) => (
        <li
          className="grid gap-1.5 rounded-md bg-muted p-3 text-sm"
          key={`${entry.kind}:${entry.id}`}
        >
          {entry.kind === "conversation" ? (
            <>
              <p className="font-medium">
                {entry.title ?? "A conversation"}
                {entry.available ? "" : " (no longer available)"}
              </p>
              {entry.messages.map((message) => (
                <p className="text-pretty" key={message.id}>
                  <span className="text-muted-foreground">
                    {message.role === "user"
                      ? "Person: "
                      : message.role === "assistant"
                        ? "Bot: "
                        : "Tool: "}
                  </span>
                  {message.content}
                </p>
              ))}
            </>
          ) : (
            <p>
              {`A recording${entry.available ? "" : " (no longer available)"}: ${entry.events.join(", ") || `${entry.eventCount} steps`}`}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** One proposed skill: the SKILL.md it publishes, why, and the evidence, with Approve and Reject. */
function ProposalDialog({
  agentId,
  onClose,
  proposalId,
}: {
  agentId?: string;
  onClose: () => void;
  proposalId: string;
}) {
  const detail = useQuery(learningProposalQueryOptions(proposalId, agentId));
  const review = useMutation(
    reviewLearningProposalMutationOptions(appQueryClient),
  );
  const proposal = detail.data;
  const skill = proposal?.files.find((file) => file.path === "SKILL.md");
  const others = proposal?.files.filter((file) => file.path !== "SKILL.md");
  const decide = (decision: "approve" | "reject") =>
    review.mutate({ proposalId, decision, ...(agentId ? { agentId } : {}) });
  const decided = review.data?.status ?? proposal?.status;
  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{proposal?.title ?? "Proposed skill"}</DialogTitle>
          {proposal && (
            <DialogDescription>{proposal.description}</DialogDescription>
          )}
        </DialogHeader>
        <DialogBody className="mt-4 gap-5 overflow-y-auto">
          {detail.isPending ? null : detail.error ? (
            <p role="alert" className="text-destructive text-sm">
              {detail.error.message}
            </p>
          ) : (
            <>
              <section className="grid gap-1.5">
                <h3 className="font-medium text-sm">Why</h3>
                <p className="text-pretty text-sm">{proposal?.reason}</p>
              </section>
              {skill && (
                <section className="grid gap-1.5">
                  <h3 className="font-medium text-sm">SKILL.md</h3>
                  <div className="rounded-md border p-3">
                    <Streamdown
                      className="min-w-0 text-sm [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_li]:my-0 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                      components={markdownComponents}
                      mode="static"
                    >
                      {skillBody(skill.content)}
                    </Streamdown>
                  </div>
                </section>
              )}
              {others && others.length > 0 && (
                <section className="grid gap-1.5">
                  <h3 className="font-medium text-sm">Other files</h3>
                  {others.map((file) => (
                    <details
                      className="rounded-md border p-3 text-sm"
                      key={file.path}
                    >
                      <summary className="cursor-pointer">{file.path}</summary>
                      <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs">
                        {file.content}
                      </pre>
                    </details>
                  ))}
                </section>
              )}
              {proposal && proposal.insights.length > 0 && (
                <section className="grid gap-3">
                  <h3 className="font-medium text-sm">Learned from</h3>
                  {proposal.insights.map((insight) => (
                    <div className="grid gap-2" key={insight.id}>
                      <p className="text-pretty text-sm">{insight.statement}</p>
                      <EvidenceList evidence={insight.evidence} />
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
          {review.error && (
            <p role="alert" className="text-destructive text-sm">
              {review.error.message}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          {decided === "pending_review" ? (
            <>
              <Button
                disabled={review.isPending}
                onClick={() => decide("reject")}
                size="sm"
                type="button"
                variant="outline"
              >
                Reject
              </Button>
              <Button
                disabled={review.isPending}
                onClick={() => decide("approve")}
                size="sm"
                type="button"
              >
                {review.isPending ? "Saving…" : "Approve and publish"}
              </Button>
            </>
          ) : (
            <>
              {decided && (
                <span
                  className="mr-auto text-muted-foreground text-sm"
                  role="status"
                >
                  {decided === "approved"
                    ? "Published. Bots on this container use it from their next conversation."
                    : "Rejected. It won't be published."}
                </span>
              )}
              <Button onClick={onClose} size="sm" type="button">
                Done
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
