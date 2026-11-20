import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  DescribeRule,
  type WrittenRule,
} from "@/components/boundaries/describe-rule";
import { DryRunChanges } from "@/components/boundaries/dry-run-changes";
import { RulePreview } from "@/components/boundaries/rule-preview";
import { RuleReading } from "@/components/boundaries/rule-reading";
import {
  PageCard,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
  ruleLabel,
  withoutRule,
  withRuleReplaced,
} from "@/lib/boundaries/rules";
import { saveActionPolicyMutationOptions } from "@/lib/computers/mutations";
import {
  type ActionPolicy,
  actionPolicyQueryOptions,
  policyDryRunQueryOptions,
} from "@/lib/computers/queries";

/** How long the rule has to rest before it is replayed, as on Add rule. */
const PREVIEW_DELAY_MS = 400;

export const Route = createFileRoute("/_authed/admin/boundaries_/$index")({
  component: RulePage,
});

const BACK = {
  label: "Boundaries",
  linkProps: { to: "/admin/boundaries" as const },
};

/**
 * One rule: what it is called, what it is made of, and what it has stopped lately.
 *
 * Addressed by position because a rule has no id of its own, only its text. A position that no
 * longer holds a rule, because it was removed elsewhere, says so rather than showing a neighbour.
 */
function RulePage() {
  const { index } = Route.useParams();
  const stored = useQuery(actionPolicyQueryOptions());
  const policy = stored.data;
  const rule = policy?.deny[Number(index)];

  if (!policy) {
    return (
      <PageShell backButton={BACK} title="Rule">
        {stored.error ? (
          <p className="text-destructive text-sm" role="alert">
            {stored.error.message}
          </p>
        ) : null}
      </PageShell>
    );
  }
  if (rule === undefined) {
    return (
      <PageShell backButton={BACK} title="Rule">
        <p className="text-muted-foreground text-sm">
          This rule isn't in place anymore. It may have been removed.
        </p>
      </PageShell>
    );
  }
  // Keyed by the rule, so a saved change starts the editor and its preview afresh from what is stored.
  return <RuleDetail key={rule} policy={policy} rule={rule} />;
}

function RuleDetail({ policy, rule }: { policy: ActionPolicy; rule: string }) {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));
  const [removing, setRemoving] = useState(false);
  const label = ruleLabel(policy, rule);

  /*
   * What this rule has stopped, read as the difference it makes: the policy without it, replayed
   * over recent actions, would have allowed exactly the ones it stopped. A Bot's computer actions
   * and its app calls alike, so a rule about an app shows the calls it stopped.
   */
  const reach = useQuery(policyDryRunQueryOptions(withoutRule(policy, rule)));

  const remove = () =>
    savePolicy.mutate(withoutRule(policy, rule), {
      onSuccess: () => void navigate({ to: "/admin/boundaries" }),
    });

  return (
    <PageShell
      backButton={BACK}
      description={label.description || undefined}
      title={label.name}
    >
      {policy.mode === "dry-run" ? (
        <p className="text-amber-600 text-sm dark:text-amber-500">
          Trial mode is on, so this rule records matching actions without
          stopping them.
        </p>
      ) : null}

      <PageSection
        description="Written in CEL. It is checked before every action a Bot takes."
        title="Rule"
      >
        <RuleEditor policy={policy} rule={rule} />
      </PageSection>

      <PageSection title="Recently stopped">
        {reach.isPending ? null : reach.error ? (
          <p className="mt-4 text-muted-foreground text-sm">
            {reach.error.message}
          </p>
        ) : reach.data.scanned === 0 ? (
          <p className="mt-4 text-muted-foreground text-sm">
            No recorded actions yet. What this rule stops will show here once
            Bots have acted.
          </p>
        ) : (
          <>
            <p className="mt-4 text-muted-foreground text-sm">
              {reach.data.wouldAllow === 0
                ? `It stopped none of the last ${reach.data.scanned} recorded actions.`
                : `It stopped ${reach.data.wouldAllow} of the last ${reach.data.scanned} recorded actions.`}
            </p>
            <DryRunChanges
              changes={reach.data.changes.filter(
                (change) => change.would === "allowed",
              )}
              total={reach.data.wouldAllow}
              verdict="Stopped"
            />
          </>
        )}
      </PageSection>

      <PageSection
        description="Bots can do this again from their next action."
        title="Remove"
      >
        <Button
          className="mt-4"
          onClick={() => setRemoving(true)}
          variant="destructive"
        >
          Remove rule
        </Button>
      </PageSection>

      <Dialog onOpenChange={setRemoving} open={removing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove “{label.name}”?</DialogTitle>
            <DialogDescription>
              Every Bot can do this again from its next action.
            </DialogDescription>
          </DialogHeader>
          {savePolicy.error ? (
            <p className="text-destructive text-sm" role="alert">
              {savePolicy.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setRemoving(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={savePolicy.isPending}
              onClick={remove}
              size="sm"
              variant="destructive"
            >
              {savePolicy.isPending ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

/**
 * The rule, editable in CEL or rewritten from a description, and saved only by Save rule.
 *
 * A changed rule is replayed on its own as it rests, as Add rule replays a new one, so what the new
 * version would have stopped sits right above what the rule in force has stopped. Saved, it takes
 * the old rule's place and name.
 */
function RuleEditor({ policy, rule }: { policy: ActionPolicy; rule: string }) {
  const queryClient = useQueryClient();
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));
  const [draft, setDraft] = useState(rule);
  const [written, setWritten] = useState<WrittenRule | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const trimmed = draft.trim();
  const changed = trimmed !== rule;
  const duplicate = changed && policy.deny.includes(trimmed);
  // The model's rule, unedited, that the compiler refused: its error is already under the rule.
  const broken = Boolean(
    written && !written.compile.ok && written.rule.trim() === trimmed,
  );
  const ready = changed && Boolean(trimmed) && !duplicate && !broken;

  const [settled, setSettled] = useState(rule);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(trimmed), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);
  const candidate: ActionPolicy | null =
    settled && settled !== rule && !policy.deny.includes(settled) && !broken
      ? { mode: policy.mode, deny: [settled], allow: ["true"] }
      : null;
  const preview = useQuery({
    ...policyDryRunQueryOptions(
      candidate ?? { mode: "enforce", deny: [], allow: [] },
    ),
    enabled: candidate !== null,
    placeholderData: keepPreviousData,
  });

  /* The model's rule goes into the CEL field, where the preview picks it up as it would any edit. */
  const takeWritten = (next: WrittenRule) => {
    setWritten(next);
    setDraft(next.rule);
  };

  const reset = () => {
    setDraft(rule);
    setWritten(null);
    setProblem(null);
  };

  const save = () => {
    if (!ready) return;
    setProblem(null);
    savePolicy.mutate(
      {
        ...withRuleReplaced(policy, rule, trimmed),
        ...(written
          ? { authoring: { source: "english" as const, text: written.text } }
          : {}),
      },
      { onError: (thrown: Error) => setProblem(thrown.message) },
    );
  };

  return (
    <form
      className="mt-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <PageCard
        footer={
          changed ? (
            <>
              <Button onClick={reset} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={!ready || savePolicy.isPending} type="submit">
                {savePolicy.isPending ? "Saving…" : "Save rule"}
              </Button>
            </>
          ) : undefined
        }
      >
        <FieldGroup>
          <DescribeRule onWritten={takeWritten} />
          <Field>
            <FieldLabel htmlFor="rule-expression">Rule</FieldLabel>
            <Textarea
              autoCapitalize="off"
              autoCorrect="off"
              className="min-h-20 font-mono text-xs"
              id="rule-expression"
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              value={draft}
            />
            {duplicate ? (
              <p className="text-destructive text-sm">
                This rule is already in place.
              </p>
            ) : null}
            {written ? <RuleReading rule={draft} written={written} /> : null}
          </Field>
          {changed && candidate && !duplicate ? (
            <RulePreview preview={preview} />
          ) : null}
        </FieldGroup>

        {/* A save refused for the reason the preview already gives says nothing twice. */}
        {problem && problem !== preview.error?.message ? (
          <p className="mt-5 text-destructive text-sm" role="alert">
            {problem}
          </p>
        ) : null}
      </PageCard>
    </form>
  );
}
