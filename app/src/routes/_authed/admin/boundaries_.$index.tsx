import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { DryRunChanges } from "@/components/boundaries/dry-run-changes";
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
import { ruleLabel, withoutRule } from "@/lib/boundaries/rules";
import { saveActionPolicyMutationOptions } from "@/lib/computers/mutations";
import {
  type ActionPolicy,
  actionPolicyQueryOptions,
  dryRunActionPolicy,
} from "@/lib/computers/queries";

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
  return <RuleDetail policy={policy} rule={rule} />;
}

function RuleDetail({ policy, rule }: { policy: ActionPolicy; rule: string }) {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));
  const [removing, setRemoving] = useState(false);
  const label = ruleLabel(policy, rule);

  /*
   * What this rule has stopped, read as the difference it makes: the policy without it, replayed
   * over recent actions, would have allowed exactly the ones it stopped.
   */
  const reach = useQuery({
    queryKey: ["computers", "policy", "reach", rule],
    queryFn: () => dryRunActionPolicy(withoutRule(policy, rule)),
  });

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
        <PageCard className="mt-4">
          <code className="block whitespace-pre-wrap break-all font-mono text-xs">
            {rule}
          </code>
        </PageCard>
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
