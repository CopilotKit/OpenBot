import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type ApprovalRuleInput,
  type ApprovalRuleRow,
  BEHAVIOUR_LABELS,
  type HostCommandPolicy,
  type RuleBehaviour,
} from "@/lib/approvals";

export const HOST_LABELS: Record<HostCommandPolicy, string> = {
  ask: "Ask every time",
  allow: "Always allow",
  never: "Never",
};
export const selectClass =
  "h-9 rounded-md border bg-background px-2 text-sm disabled:opacity-50";

export function RuleRow({
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
export function RuleForm({
  label,
  pending,
  onSave,
  botField = true,
}: {
  label: string;
  pending: boolean;
  onSave: (input: ApprovalRuleInput) => void;
  /** Off where the rule applies to every Bot, so there is no Bot to name. */
  botField?: boolean;
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
      {botField ? field("botId", "Bot", "* for every Bot") : null}
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
