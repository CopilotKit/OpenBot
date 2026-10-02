import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  type ApprovalDecision,
  type ApprovalRuleInput,
  type ApprovalRuleRow,
  answerPersonQuestion,
  approvalInboxOptions,
  BEHAVIOUR_LABELS,
  createApprovalRule,
  createTeamApprovalRule,
  decideApproval,
  type HostCommandPolicy,
  type RuleBehaviour,
  revokeApprovalRule,
  revokeTeamApprovalRule,
  setApprovalEnabled,
  setApprovalPreferences,
  setTeamApprovalSettings,
  updateApprovalRule,
  updateTeamApprovalRule,
} from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";

const HOST_LABELS: Record<HostCommandPolicy, string> = {
  ask: "Ask every time",
  allow: "Always allow",
  never: "Never",
};
const selectClass =
  "h-9 rounded-md border bg-background px-2 text-sm disabled:opacity-50";

export function ApprovalInbox() {
  const cache = useQueryClient();
  const inbox = useQuery(approvalInboxOptions());
  const refresh = () => cache.invalidateQueries({ queryKey: ["approvals"] });
  const decision = useMutation({
    mutationFn: ({ id, choice }: { id: string; choice: ApprovalDecision }) =>
      decideApproval(id, choice),
    onSuccess: refresh,
  });
  const preference = useMutation({
    mutationFn: setApprovalEnabled,
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: revokeApprovalRule,
    onSuccess: refresh,
  });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const answer = useMutation({
    mutationFn: ({ id, response }: { id: string; response: string }) =>
      answerPersonQuestion(id, response),
    onSuccess: refresh,
  });
  const { data: me } = useQuery(currentUserQueryOptions());
  const isAdmin = me?.role === "admin";
  const preferences = useMutation({
    mutationFn: setApprovalPreferences,
    onSuccess: refresh,
  });
  const addRule = useMutation({
    mutationFn: createApprovalRule,
    onSuccess: refresh,
  });
  const team = useMutation({
    mutationFn: setTeamApprovalSettings,
    onSuccess: refresh,
  });
  const addTeamRule = useMutation({
    mutationFn: createTeamApprovalRule,
    onSuccess: refresh,
  });
  const changeRule = useMutation({
    mutationFn: ({ id, behaviour }: { id: string; behaviour: RuleBehaviour }) =>
      updateApprovalRule(id, { behaviour }),
    onSuccess: refresh,
  });
  const changeTeamRule = useMutation({
    mutationFn: ({ id, behaviour }: { id: string; behaviour: RuleBehaviour }) =>
      updateTeamApprovalRule(id, { behaviour }),
    onSuccess: refresh,
  });
  const revokeTeam = useMutation({
    mutationFn: revokeTeamApprovalRule,
    onSuccess: refresh,
  });
  const error =
    inbox.error ??
    decision.error ??
    preference.error ??
    revoke.error ??
    answer.error ??
    preferences.error ??
    addRule.error ??
    team.error ??
    addTeamRule.error ??
    revokeTeam.error ??
    changeRule.error ??
    changeTeamRule.error;
  const enforced = inbox.data?.team?.enforceAutoReview ?? false;
  const rulesOff = inbox.data?.team?.customRulesEnabled === false;
  const pending =
    inbox.data?.requests.filter((request) => request.status === "pending") ??
    [];
  return (
    <div className="space-y-6">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
      <label
        htmlFor="ask-before-changes"
        className="flex items-center justify-between gap-4 rounded-lg border p-4"
      >
        <span>
          <span className="block font-medium">Ask before making changes</span>
          <span className="text-sm text-muted-foreground">
            Review a Bot's changes to websites, connected apps, and files.
          </span>
        </span>
        <Switch
          id="ask-before-changes"
          aria-label="Ask before making changes"
          checked={inbox.data?.enabled ?? false}
          disabled={inbox.isLoading || preference.isPending}
          onCheckedChange={(enabled) => preference.mutate(enabled)}
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
                information, a model checks it against what you asked for, your
                rules and the safety requirements. If it cannot decide, it asks
                you.
              </span>
            </span>
            <Switch
              id="auto-review"
              // Named by its title alone and described by the sentence under it, so the name does
              // not depend on how a label wrapping a composite control is resolved.
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
                inbox.data.hostCommands !== inbox.data.preferences.hostCommands
                  ? `Your team limits this to "${HOST_LABELS[inbox.data.hostCommands]}". `
                  : ""}
                The OpenBot desktop app still shows each command before it runs
                on your computer.
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
              {(Object.keys(HOST_LABELS) as HostCommandPolicy[]).map((key) => (
                <option key={key} value={key}>
                  {HOST_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : null}
      <div className="space-y-3">
        <h2 className="font-medium">Waiting for you</h2>
        {inbox.data?.questions.map((question) => (
          <article
            key={question.id}
            className="space-y-3 rounded-lg border p-4"
          >
            <h3 className="font-medium">
              {question.botId} asks: {question.question}
            </h3>
            {question.why ? (
              <p className="text-sm text-muted-foreground">{question.why}</p>
            ) : null}
            <Textarea
              aria-label="Your answer"
              placeholder="Your answer"
              value={answers[question.id] ?? ""}
              onChange={(event) =>
                setAnswers((prior) => ({
                  ...prior,
                  [question.id]: event.target.value,
                }))
              }
            />
            <Button
              disabled={answer.isPending || !answers[question.id]?.trim()}
              onClick={() =>
                answer.mutate({
                  id: question.id,
                  response: answers[question.id] ?? "",
                })
              }
            >
              Send answer
            </Button>
          </article>
        ))}
        {inbox.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading approvals…</p>
        ) : pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No actions need your approval.
          </p>
        ) : (
          pending.map((request) => (
            <article
              className="space-y-3 rounded-lg border p-4"
              key={request.id}
            >
              <div>
                <h3 className="font-medium">
                  {request.action.botId} wants to{" "}
                  {request.action.toolRef
                    .replace(/^computer_|^host\//, "")
                    .replaceAll("_", " ")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {request.action.scope}
                </p>
                {request.action.policy ? (
                  <p className="text-sm">
                    {request.action.policy.behaviour === "hand_off"
                      ? "Handed to you: "
                      : ""}
                    {request.action.policy.reason}
                  </p>
                ) : null}
              </div>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                {JSON.stringify(request.action.args, null, 2)}
              </pre>
              {request.action.policy?.behaviour === "hand_off" ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={decision.isPending}
                    onClick={() =>
                      decision.mutate({ id: request.id, choice: "handled" })
                    }
                  >
                    I did it myself
                  </Button>
                  <Button
                    variant="outline"
                    disabled={decision.isPending}
                    onClick={() =>
                      decision.mutate({ id: request.id, choice: "deny" })
                    }
                  >
                    Don't do it
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={decision.isPending}
                    onClick={() =>
                      decision.mutate({ id: request.id, choice: "allow_once" })
                    }
                  >
                    Allow once
                  </Button>
                  <Button
                    variant="outline"
                    disabled={decision.isPending}
                    onClick={() =>
                      decision.mutate({
                        id: request.id,
                        choice: "allow_always",
                      })
                    }
                  >
                    Always allow here
                  </Button>
                  <Button
                    variant="outline"
                    disabled={decision.isPending}
                    onClick={() =>
                      decision.mutate({ id: request.id, choice: "deny" })
                    }
                  >
                    Deny
                  </Button>
                </div>
              )}
            </article>
          ))
        )}
      </div>
      <div className="space-y-3">
        <h2 className="font-medium">Rules</h2>
        <p className="text-sm text-muted-foreground">
          The strictest matching rule wins, so an "ask" rule beats an "allow"
          one. Team rules are locked. Changing a password, security settings and
          payments are always handed to you.
          {rulesOff
            ? " Your team has switched personal rules off, so they are kept but do not apply."
            : ""}
        </p>
        {inbox.data?.teamRules.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            locked={!isAdmin}
            disabled={revokeTeam.isPending || changeTeamRule.isPending}
            onRevoke={() => revokeTeam.mutate(rule.id)}
            onChange={(behaviour) =>
              changeTeamRule.mutate({ id: rule.id, behaviour })
            }
            team
          />
        ))}
        {inbox.data?.rules.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            locked={rulesOff}
            disabled={revoke.isPending || changeRule.isPending}
            onRevoke={() => revoke.mutate(rule.id)}
            onChange={(behaviour) =>
              changeRule.mutate({ id: rule.id, behaviour })
            }
          />
        ))}
        {!inbox.data?.rules.length && !inbox.data?.teamRules.length ? (
          <p className="text-sm text-muted-foreground">No rules saved.</p>
        ) : null}
        {inbox.data?.preferences && !rulesOff ? (
          <RuleForm
            label="Add a rule"
            pending={addRule.isPending}
            onSave={(input) => addRule.mutate(input)}
          />
        ) : null}
      </div>
      {isAdmin && inbox.data?.team ? (
        <div className="space-y-3">
          <h2 className="font-medium">Team settings</h2>
          <label
            htmlFor="enforce-auto-review"
            className="flex items-center justify-between gap-4 rounded-lg border p-4"
          >
            <span id="enforce-auto-review-title" className="font-medium">
              Require auto-review for everyone
            </span>
            <Switch
              id="enforce-auto-review"
              aria-labelledby="enforce-auto-review-title"
              checked={inbox.data.team.enforceAutoReview}
              disabled={team.isPending}
              onCheckedChange={(enforceAutoReview) =>
                team.mutate({ enforceAutoReview })
              }
            />
          </label>
          <label
            htmlFor="custom-rules"
            className="flex items-center justify-between gap-4 rounded-lg border p-4"
          >
            <span id="custom-rules-title" className="font-medium">
              Let members set personal rules
            </span>
            <Switch
              id="custom-rules"
              aria-labelledby="custom-rules-title"
              checked={inbox.data.team.customRulesEnabled}
              disabled={team.isPending}
              onCheckedChange={(customRulesEnabled) =>
                team.mutate({ customRulesEnabled })
              }
            />
          </label>
          <label
            htmlFor="host-commands-cap"
            className="flex items-center justify-between gap-4 rounded-lg border p-4"
          >
            <span>
              <span className="block font-medium">
                Commands on members' computers, at most
              </span>
              <span className="text-sm text-muted-foreground">
                A member's own stricter setting still applies.
              </span>
            </span>
            <select
              id="host-commands-cap"
              aria-label="Commands on members' computers, at most"
              className={selectClass}
              value={inbox.data.team.hostCommandsCap}
              disabled={team.isPending}
              onChange={(event) =>
                team.mutate({
                  hostCommandsCap: event.target.value as HostCommandPolicy,
                })
              }
            >
              {(Object.keys(HOST_LABELS) as HostCommandPolicy[]).map((key) => (
                <option key={key} value={key}>
                  {HOST_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
          <RuleForm
            label="Add a team rule"
            pending={addTeamRule.isPending}
            onSave={(input) => addTeamRule.mutate(input)}
          />
        </div>
      ) : null}
    </div>
  );
}

function RuleRow({
  rule,
  team,
  locked,
  disabled,
  onRevoke,
  onChange,
}: {
  rule: ApprovalRuleRow;
  team?: boolean;
  locked?: boolean;
  disabled: boolean;
  onRevoke: () => void;
  onChange: (behaviour: RuleBehaviour) => void;
}) {
  const label = `${BEHAVIOUR_LABELS[rule.behaviour]}${team ? " (team rule)" : ""}`;
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
      <div className="space-y-1">
        {locked ? (
          <p className="text-sm font-medium">{label}</p>
        ) : (
          <select
            aria-label={`Behaviour for ${rule.toolRef}`}
            className={selectClass}
            value={rule.behaviour}
            disabled={disabled}
            onChange={(event) => {
              const behaviour = event.target.value as RuleBehaviour;
              onChange(behaviour);
            }}
          >
            {(Object.keys(BEHAVIOUR_LABELS) as RuleBehaviour[]).map((key) => (
              <option key={key} value={key}>
                {BEHAVIOUR_LABELS[key]}
                {team ? " (team rule)" : ""}
              </option>
            ))}
          </select>
        )}
        <p className="text-sm text-muted-foreground">
          {rule.toolRef}
          {rule.effect !== "*" ? `, ${rule.effect}` : ""}
          {rule.scope !== "*" ? ` on ${rule.scope}` : ""}
          {rule.botId !== "*" ? ` for ${rule.botId}` : ""}
        </p>
      </div>
      {locked ? (
        <span className="text-sm text-muted-foreground">Locked</span>
      ) : (
        <Button variant="outline" disabled={disabled} onClick={onRevoke}>
          Remove
        </Button>
      )}
    </div>
  );
}

const EMPTY_RULE: ApprovalRuleInput = {
  botId: "*",
  toolRef: "",
  effect: "*",
  scope: "*",
  behaviour: "ask",
};

/**
 * An action class and a behaviour. `*` matches anything, so `mcp/gmail/*` is every Gmail tool and a
 * target of `*.example.com` is every page on that site.
 */
function RuleForm({
  label,
  pending,
  onSave,
}: {
  label: string;
  pending: boolean;
  onSave: (input: ApprovalRuleInput) => void;
}) {
  const [rule, setRule] = useState<ApprovalRuleInput>(EMPTY_RULE);
  const field = (key: keyof ApprovalRuleInput, title: string, hint: string) => (
    <label className="grid gap-1 text-sm">
      <span>{title}</span>
      <input
        aria-label={title}
        className="h-9 rounded-md border bg-background px-2"
        placeholder={hint}
        value={rule[key]}
        onChange={(event) => {
          // Read before the updater runs: React restores a controlled input's DOM value first.
          const value = event.target.value;
          setRule((prior) => ({ ...prior, [key]: value }));
        }}
      />
    </label>
  );
  return (
    <form
      className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(rule);
        setRule(EMPTY_RULE);
      }}
    >
      <h3 className="font-medium sm:col-span-2">{label}</h3>
      {field("toolRef", "Tool or app", "mcp/gmail/*, computer_click, host/*")}
      {field("effect", "Kind of action", "* , write, read, delegate")}
      {field("scope", "Target", "*, a site, a folder, a Bot name")}
      {field("botId", "Bot", "* for every Bot")}
      <label className="grid gap-1 text-sm">
        <span>Behaviour</span>
        <select
          aria-label="Behaviour"
          className={selectClass}
          value={rule.behaviour}
          onChange={(event) => {
            const behaviour = event.target.value as RuleBehaviour;
            setRule((prior) => ({ ...prior, behaviour }));
          }}
        >
          {(Object.keys(BEHAVIOUR_LABELS) as RuleBehaviour[]).map((key) => (
            <option key={key} value={key}>
              {BEHAVIOUR_LABELS[key]}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-end">
        <Button type="submit" disabled={pending || !rule.toolRef.trim()}>
          Save rule
        </Button>
      </div>
    </form>
  );
}
