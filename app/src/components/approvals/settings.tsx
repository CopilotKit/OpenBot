import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PageSection } from "@/components/layout/page-shell";
import { Switch } from "@/components/ui/switch";
import {
  approvalInboxOptions,
  approvalPreferencesMutationOptions,
  createApprovalRuleMutationOptions,
  type HostCommandPolicy,
  revokeApprovalRuleMutationOptions,
  ruleCoversBot,
  updateApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { queryClient } from "@/query-client";
import { HOST_LABELS, RuleForm, RuleRow, selectClass } from "./rules";

/**
 * The person's own approval settings: whether their Bots ask before changing things, and the rules
 * that apply to every one of their Bots. Team rules are listed so the person can see them, locked;
 * administrators change them in Admin → Approvals. Rules for a single Bot are on that Bot's page.
 */
export function ApprovalSettings() {
  const inbox = useQuery(approvalInboxOptions());
  const me = useQuery(currentUserQueryOptions()).data;
  const agents = useQuery(agentListQueryOptions());
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const preferences = useMutation(
    approvalPreferencesMutationOptions(queryClient),
  );
  const addRule = useMutation(createApprovalRuleMutationOptions(queryClient));
  const changeRule = useMutation(
    updateApprovalRuleMutationOptions(queryClient),
  );
  const revoke = useMutation(revokeApprovalRuleMutationOptions(queryClient));
  const error =
    inbox.error ??
    preferences.error ??
    addRule.error ??
    changeRule.error ??
    revoke.error;
  if (inbox.isPending && !error) return null;
  const enforced = inbox.data?.team?.enforceAutoReview ?? false;
  const rulesOff = inbox.data?.team?.customRulesEnabled === false;
  const everyBot = (inbox.data?.rules ?? []).filter(
    (rule) => rule.botId === "*",
  );
  /*
   * Rules that name no Bot this person can open — a Bot since deleted, or a name typed where an id
   * belonged. They are still enforced, so they are listed here where they can be removed.
   */
  const reachable = [...(agents.data ?? []), ...(hiddenAgents.data ?? [])];
  const otherBots = (inbox.data?.rules ?? []).filter(
    (rule) =>
      rule.botId !== "*" &&
      (agents.data === undefined ||
        !reachable.some((agent) => ruleCoversBot(rule.botId, agent.id))),
  );
  const teamRules = inbox.data?.teamRules ?? [];

  return (
    <>
      {error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {me?.role === "admin" ? (
        <p className="mt-6 text-muted-foreground text-sm">
          Team settings and shared account requests are in{" "}
          <Link className="underline underline-offset-4" to="/admin/approvals">
            Admin → Approvals
          </Link>
          .
        </p>
      ) : null}
      <PageSection title="Before a Bot acts">
        <div className="mt-4 space-y-3">
          <label
            htmlFor="ask-before-changes"
            className="flex items-center justify-between gap-4 rounded-lg border p-4"
          >
            <span>
              <span className="block font-medium">
                Ask before making changes
              </span>
              <span className="text-sm text-muted-foreground">
                Review a Bot's changes to websites, connected apps, and files.
              </span>
            </span>
            <Switch
              id="ask-before-changes"
              aria-label="Ask before making changes"
              checked={inbox.data?.enabled ?? false}
              disabled={inbox.isLoading || preferences.isPending}
              onCheckedChange={(enabled) => preferences.mutate({ enabled })}
            />
          </label>
          {inbox.data?.preferences ? (
            <>
              <label
                htmlFor="auto-review"
                className="flex items-center justify-between gap-4 rounded-lg border p-4"
              >
                <span>
                  <span id="auto-review-title" className="block font-medium">
                    Auto-review
                  </span>
                  <span
                    id="auto-review-description"
                    className="text-sm text-muted-foreground"
                  >
                    {enforced ? "Required by your team. " : ""}
                    Before an action that could affect your accounts or share
                    information, a model checks it against what you asked for,
                    your rules and the safety requirements. If it cannot decide,
                    it asks you.
                  </span>
                </span>
                <Switch
                  id="auto-review"
                  // Named by its title alone and described by the sentence under it, so the name
                  // does not depend on how a label wrapping a composite control is resolved.
                  aria-labelledby="auto-review-title"
                  aria-describedby="auto-review-description"
                  checked={enforced || inbox.data.preferences.autoReview}
                  disabled={enforced || preferences.isPending}
                  onCheckedChange={(autoReview) =>
                    preferences.mutate({ autoReview })
                  }
                />
              </label>
              <label
                htmlFor="host-commands"
                className="flex items-center justify-between gap-4 rounded-lg border p-4"
              >
                <span>
                  <span className="block font-medium">
                    Commands on your computer
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {inbox.data.hostCommands &&
                    inbox.data.hostCommands !==
                      inbox.data.preferences.hostCommands
                      ? `Your team limits this to "${HOST_LABELS[inbox.data.hostCommands]}". `
                      : ""}
                    The OpenBot desktop app still shows each command before it
                    runs on your computer.
                  </span>
                </span>
                <select
                  id="host-commands"
                  aria-label="Commands on your computer"
                  className={selectClass}
                  value={inbox.data.preferences.hostCommands}
                  disabled={preferences.isPending}
                  onChange={(event) =>
                    preferences.mutate({
                      hostCommands: event.target.value as HostCommandPolicy,
                    })
                  }
                >
                  {(Object.keys(HOST_LABELS) as HostCommandPolicy[]).map(
                    (key) => (
                      <option key={key} value={key}>
                        {HOST_LABELS[key]}
                      </option>
                    ),
                  )}
                </select>
              </label>
            </>
          ) : null}
        </div>
      </PageSection>
      <PageSection
        description={
          <>
            The strictest matching rule wins, so an "ask" rule beats an "allow"
            one. Team rules are locked. Changing a password, security settings
            and payments are always handed to you. Rules for a single Bot are on{" "}
            <Link className="underline underline-offset-4" to="/bots">
              that Bot's page
            </Link>
            .
            {rulesOff
              ? " Your team has switched personal rules off, so they are kept but do not apply."
              : ""}
          </>
        }
        title="Rules for every Bot"
      >
        <div className="mt-4 space-y-3">
          {teamRules.map((rule) => (
            <RuleRow
              disabled
              key={rule.id}
              locked
              onChange={() => {}}
              onRevoke={() => {}}
              rule={rule}
              team
            />
          ))}
          {everyBot.map((rule) => (
            <RuleRow
              disabled={revoke.isPending || changeRule.isPending}
              key={rule.id}
              locked={rulesOff}
              onChange={(behaviour) =>
                changeRule.mutate({ id: rule.id, behaviour })
              }
              onRevoke={() => revoke.mutate(rule.id)}
              rule={rule}
            />
          ))}
          {everyBot.length === 0 && teamRules.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rules saved.</p>
          ) : null}
          {inbox.data?.preferences && !rulesOff ? (
            <RuleForm
              botField={false}
              label="Add a rule"
              onSave={(input) => addRule.mutate(input)}
              pending={addRule.isPending}
            />
          ) : null}
        </div>
      </PageSection>
      {agents.data !== undefined && otherBots.length > 0 ? (
        <PageSection
          description="These name no Bot you can open, but they still apply to any Bot they match. Remove the ones you no longer want."
          title="Rules for other Bots"
        >
          <div className="mt-4 space-y-3">
            {otherBots.map((rule) => (
              <RuleRow
                disabled={revoke.isPending || changeRule.isPending}
                key={rule.id}
                locked={rulesOff}
                onChange={(behaviour) =>
                  changeRule.mutate({ id: rule.id, behaviour })
                }
                onRevoke={() => revoke.mutate(rule.id)}
                rule={rule}
              />
            ))}
          </div>
        </PageSection>
      ) : null}
    </>
  );
}
