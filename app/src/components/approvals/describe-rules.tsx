import {
  IconDeviceDesktop,
  IconFolder,
  IconLock,
  IconPlug,
  IconPlus,
  IconTrash,
  IconUsers,
} from "@tabler/icons-react";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import type { AuditEvent } from "@/components/audit/audit-cells";
import {
  type ReplayRow,
  ReplayRows,
} from "@/components/boundaries/dry-run-changes";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import type {
  ApprovalBacktest,
  ApprovalRulesPreview,
  BacktestChange,
} from "@/lib/approval-rules/queries";
import type { RuleRowProblem } from "@/lib/approval-rules/translate";
import { type ApprovalRuleInput, BEHAVIOUR_LABELS } from "@/lib/approvals";
import { LabelSelect } from "./rules";

/** More than this is not one description's worth; the server refuses it too. */
export const MAX_RULES = 8;

export const BLANK_RULE: ApprovalRuleInput = {
  toolRef: "",
  effect: "*",
  scope: "*",
  botId: "*",
  behaviour: "ask",
};

const FIELDS: {
  key: "toolRef" | "effect" | "scope";
  label: string;
  placeholder: string;
}[] = [
  {
    key: "toolRef",
    label: "Tool or app",
    placeholder: "composio-gmail/*, computer_click, host/*",
  },
  { key: "effect", label: "Kind of action", placeholder: "*, write, read" },
  { key: "scope", label: "Target", placeholder: "*, an app, a site" },
];

/**
 * The Bots a rule can name, by the names people know them by: every Bot, each Bot, and whatever the
 * rule names now when it is none of those (a pattern, or a Bot that is gone), as it is written.
 */
function botLabels(
  bots: readonly AgentProfile[] | undefined,
  current: string,
): Record<string, string> {
  const labels: Record<string, string> = { "*": "Every Bot" };
  for (const bot of bots ?? []) labels[bot.id] = bot.name;
  if (!(current in labels)) labels[current] = current || "No Bot";
  return labels;
}

/**
 * The rules the model wrote, each a set of fields the admin can change before saving. What is wrong
 * with a field, as the server checks the rules as they stand now, is said under it.
 */
export function RuleRowsEditor({
  rules,
  problems,
  onChange,
}: {
  rules: ApprovalRuleInput[];
  /** From the check of the rules as they stand, which runs as they are edited. */
  problems: RuleRowProblem[];
  onChange: (rules: ApprovalRuleInput[]) => void;
}) {
  const bots = useQuery(agentListQueryOptions());
  const set = (index: number, change: Partial<ApprovalRuleInput>) =>
    onChange(
      rules.map((rule, at) => (at === index ? { ...rule, ...change } : rule)),
    );
  return (
    <Field>
      <FieldLabel>Rules</FieldLabel>
      <FieldDescription>
        Use * to match anything. Change any rule before you save.
      </FieldDescription>
      <div className="flex flex-col gap-4">
        {rules.map((rule, index) => {
          const row = index + 1;
          const id = `team-rule-${row}`;
          const problemFor = (field: keyof ApprovalRuleInput) =>
            problems.find(
              (problem) => problem.row === row && problem.field === field,
            )?.message;
          return (
            // Index-keyed: a rule has no identity apart from its place until it is saved.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <div className="flex flex-col gap-4" key={index}>
              {index > 0 ? <FieldSeparator /> : null}
              <FieldSet className="gap-3">
                <div className="flex items-center justify-between gap-2">
                  <FieldLegend className="mb-0" variant="label">
                    Rule {row}
                  </FieldLegend>
                  <Button
                    aria-label={`Remove rule ${row}`}
                    onClick={() =>
                      onChange(rules.filter((_, at) => at !== index))
                    }
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <IconTrash />
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {FIELDS.map((field) => {
                    const problem = problemFor(field.key);
                    return (
                      <Field
                        className={
                          field.key === "toolRef" ? "sm:col-span-2" : undefined
                        }
                        key={field.key}
                      >
                        <FieldLabel htmlFor={`${id}-${field.key}`}>
                          {field.label}
                        </FieldLabel>
                        <Input
                          aria-invalid={problem ? true : undefined}
                          autoCapitalize="off"
                          autoCorrect="off"
                          id={`${id}-${field.key}`}
                          onChange={(event) =>
                            set(index, { [field.key]: event.target.value })
                          }
                          placeholder={field.placeholder}
                          spellCheck={false}
                          value={rule[field.key]}
                        />
                        {problem ? (
                          <p className="text-destructive text-sm">{problem}</p>
                        ) : null}
                      </Field>
                    );
                  })}
                  <Field>
                    <FieldLabel htmlFor={`${id}-botId`}>Bot</FieldLabel>
                    <LabelSelect
                      id={`${id}-botId`}
                      labels={botLabels(bots.data, rule.botId)}
                      onChange={(botId) => set(index, { botId })}
                      value={rule.botId}
                    />
                    {problemFor("botId") ? (
                      <p className="text-destructive text-sm">
                        {problemFor("botId")}
                      </p>
                    ) : null}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${id}-behaviour`}>
                      Behaviour
                    </FieldLabel>
                    <LabelSelect
                      id={`${id}-behaviour`}
                      labels={BEHAVIOUR_LABELS}
                      onChange={(behaviour) => set(index, { behaviour })}
                      value={rule.behaviour}
                    />
                  </Field>
                </div>
              </FieldSet>
            </div>
          );
        })}
      </div>
      {rules.length < MAX_RULES ? (
        <div>
          <Button
            onClick={() => onChange([...rules, BLANK_RULE])}
            size="sm"
            type="button"
            variant="outline"
          >
            <IconPlus />
            Add a rule
          </Button>
        </div>
      ) : null}
    </Field>
  );
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * The backtest's answer in one sentence: "Would have changed 4 decisions: removes 4 asks, of which 1
 * a person had denied; adds 0 asks." Safety requirements and auto-review are never counted.
 */
export function backtestHeadline(report: ApprovalBacktest): string {
  if (report.changed === 0) return "Would have changed no decisions.";
  const removed =
    report.removedAsks > 0
      ? `removes ${plural(report.removedAsks, "ask")}, of which ${report.removedDenied} a person had denied`
      : `removes ${plural(report.removedAsks, "ask")}`;
  const moved = report.changed - report.removedAsks - report.addedAsks;
  return `Would have changed ${plural(report.changed, "decision")}: ${removed}; adds ${plural(report.addedAsks, "ask")}.${
    moved > 0 ? ` ${moved} more would move between asking and handing off.` : ""
  }`;
}

/**
 * Under the headline: what was replayed, how much of it the rules are about, what no rule changes,
 * and, for rules that ask, what the trail could not show.
 */
export function replayWords(
  report: ApprovalBacktest,
  asksMore: boolean,
): string {
  return [
    `Replayed over the last ${plural(report.scanned, "action")} OpenBot checked.`,
    report.matched === 0
      ? "These rules are about none of them."
      : `These rules are about ${report.matched} of them.`,
    report.fixed > 0
      ? `${report.fixed} ${report.fixed === 1 ? "was" : "were"} decided by a safety requirement, auto-review or a task, which rules don't change.`
      : null,
    asksMore
      ? "Actions that ran with nothing to check aren't recorded, so a new ask can reach further than this shows."
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** What the person said when they were asked, in their words. */
const ANSWERS: Record<NonNullable<BacktestChange["person"]>, string> = {
  allow_once: "A person allowed it once.",
  allow_conversation: "A person allowed it for that conversation.",
  allow_always: "A person always allowed it.",
  deny: "A person denied it.",
  handled: "A person did it themselves.",
  waiting: "Still waiting for a person.",
  withdrawn: "Withdrawn without an answer.",
};

const WOULD: Record<string, string> = {
  allow: "Wouldn't ask",
  ask: "Would ask",
  hand_off: "Would hand off",
};

/** The approval row a change was replayed from, so Audit's own cells draw it. */
function auditRowOf(change: BacktestChange): AuditEvent {
  return {
    id: change.id,
    actorUserId: change.ownerUserId,
    initiatorKind: change.initiator.kind,
    initiatorId: change.initiator.id,
    eventType: "approval.evaluated",
    targetType: "approval",
    targetId: change.toolRef,
    createdAt: change.createdAt,
    payload: {
      bot: change.bot,
      tool: change.toolRef,
      effect: change.effect,
      scope: change.scope,
      ...change.subject,
      outcome: { behaviour: change.was, source: change.wasSource },
    },
  };
}

/** Where an action acted, by its tool: an app, a computer, a folder, another Bot. */
export function mediaOf(toolRef: string): ReplayRow["media"] {
  if (toolRef.startsWith("computer_"))
    return { icon: <IconDeviceDesktop />, label: "Computer action" };
  if (toolRef.startsWith("host/"))
    return { icon: <IconFolder />, label: "Folder on a computer" };
  if (toolRef.startsWith("bot/"))
    return { icon: <IconUsers />, label: "Work handed to another Bot" };
  if (toolRef.startsWith("openbot/"))
    return { icon: <IconLock />, label: "Private information" };
  return { icon: <IconPlug />, label: "App call" };
}

function replayRowOf(change: BacktestChange): ReplayRow {
  const answer = change.person ? ANSWERS[change.person] : null;
  const fixed = change.change === "fixed";
  return {
    id: change.id,
    event: auditRowOf(change),
    media: mediaOf(change.toolRef),
    verdict: fixed ? "Unchanged" : (WOULD[change.would] ?? change.would),
    verdictClassName: fixed
      ? "text-muted-foreground"
      : change.change === "removes_ask"
        ? change.person === "deny"
          ? "text-destructive"
          : "text-amber-600 dark:text-amber-500"
        : "text-foreground",
    note: [fixed ? change.reason : null, answer].filter(Boolean).join(" "),
  };
}

/**
 * What the rules would have changed, worked out as they are edited: the headline, then each action in
 * Audit's own cells with what it would become, the asks a person had denied first. Actions a safety
 * requirement, auto-review or a task decided are listed as unchanged, after the rest.
 */
export function RulesBacktest({
  preview,
  asksMore,
}: {
  preview: UseQueryResult<ApprovalRulesPreview>;
  /** Whether a rule asks or hands off, which can reach actions the trail never recorded. */
  asksMore: boolean;
}) {
  if (preview.isPending) return null;
  return (
    <Field aria-labelledby="rules-backtest" aria-live="polite">
      <FieldLabel id="rules-backtest">On recent activity</FieldLabel>
      {preview.error ? (
        <p className="text-destructive text-sm" role="alert">
          {preview.error.message}
        </p>
      ) : preview.data.report.scanned === 0 ? (
        <FieldDescription>
          No checked actions to test against yet. You'll see what these rules
          change once Bots have acted.
        </FieldDescription>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <p className="font-medium text-sm">
              {backtestHeadline(preview.data.report)}
            </p>
            <FieldDescription className="mt-1">
              {replayWords(preview.data.report, asksMore)}
            </FieldDescription>
          </div>
          {preview.data.report.changes.length > 0 ? (
            <ReplayRows
              rows={preview.data.report.changes.map(replayRowOf)}
              total={preview.data.report.changed + preview.data.report.fixed}
            />
          ) : null}
        </div>
      )}
    </Field>
  );
}
