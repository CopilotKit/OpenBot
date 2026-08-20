import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { saveActionPolicyMutationOptions } from "@/lib/computers/mutations";
import {
  type ActionPolicy,
  actionPolicyQueryOptions,
  type PolicyMode,
} from "@/lib/computers/queries";
import { queryClient } from "@/query-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * CEL computer-action boundary editor. Rules are shown as the gateway evaluates them, and denied
 * actions are recorded in Audit with the matching rule.
 */

/**
 * Presets are concrete CEL rules, not a separate policy language.
 */
const PRESETS: { label: string; rule: string; cost?: string }[] = [
  {
    label: "Never submit a form",
    // `key` exists only on keypress actions; guard it by tool name to keep other actions evaluable.
    rule: '(intent == "activate" && contains(element.name, "submit")) || (tool.name == "computer_key" && key == "Enter")',
    cost: "Also stops the Bot pressing Enter for anything else, because a form submits from Enter in any of its fields.",
  },
  {
    label: "Never type into a password field",
    rule: 'intent == "type" && contains(element.name, "password")',
    cost: "A password box the page labels something else is not covered, the rule matches the label.",
  },
  {
    label: "Stay off social media",
    rule: 'intent == "navigate" && (contains(page.host, "facebook.com") || contains(page.host, "x.com"))',
    cost: "Only the two hosts named. A link that redirects there from somewhere else is allowed.",
  },
];

export const Route = createFileRoute("/_authed/admin/boundaries")({
  component: BoundariesPage,
});

function BoundariesPage() {
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState("");

  const stored = useQuery(actionPolicyQueryOptions());
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));

  /*
   * The saved policy wins while a save is in flight and after it lands: the server normalises what
   * it stores, so what came back is the policy, not what was sent.
   */
  const policy = savePolicy.data ?? stored.data ?? null;
  const saving = savePolicy.isPending;

  const save = (next: ActionPolicy) => {
    setSaved(false);
    setProblem(null);
    savePolicy.mutate(next, {
      onError: (thrown: Error) => setProblem(thrown.message),
      onSuccess: () => setSaved(true),
    });
  };

  if (problem && !policy) {
    return (
      <PageShell title="Boundaries">
        <p className="mt-4 text-destructive text-sm" role="alert">
          {problem}
        </p>
      </PageShell>
    );
  }

  /* Nothing until the policy is known: a rule list that guesses is worse than a blank. */
  if (!policy) {
    return <PageShell title="Boundaries">{null}</PageShell>;
  }

  const addRule = (rule: string) => {
    const trimmed = rule.trim();
    if (!trimmed || policy.deny.includes(trimmed)) return;
    void save({ ...policy, deny: [...policy.deny, trimmed] });
    setDraft("");
  };

  return (
    <PageShell
      description={
        <>
          What every Bot may and may not do with its computer. Rules are checked
          on every action before it happens, and a refusal is recorded in{" "}
          <Link className="underline" to="/admin/audit">
            Audit
          </Link>{" "}
          with the rule that refused it.
        </>
      }
      title="Boundaries"
    >
      <PageSection
        description="Enforce stops the action. Record it and allow it writes the same row and lets the action through, which is how a rule is tried on real traffic before it starts refusing anybody."
        title="When a rule matches"
      >
        <div className="mt-2 flex gap-2">
          {(["enforce", "dry-run"] as PolicyMode[]).map((mode) => (
            <Button
              key={mode}
              aria-pressed={policy.mode === mode}
              className={policy.mode === mode ? "bg-foreground/5" : undefined}
              disabled={saving}
              onClick={() => void save({ ...policy, mode })}
              size="sm"
              variant="outline"
            >
              {mode === "enforce"
                ? "Stop the action"
                : "Record it and allow it"}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {policy.mode === "enforce"
            ? "The Bot is stopped and told which rule refused it."
            : "Nothing is stopped. Every action a rule matches is recorded as it would have been refused, which is how a rule is tried out before it is switched on."}
        </p>
      </PageSection>

      <PageSection
        description={
          <>
            Checked first, and a match ends it: nothing below is consulted and
            the Bot is told which rule refused it. Rules are CEL, and can ask
            about <code>tool.name</code>, <code>intent</code>,{" "}
            <code>bot.id</code>, <code>actor.id</code>, <code>page.url</code>{" "}
            and <code>page.host</code>, the element being acted on, the{" "}
            <code>key</code> being pressed, the file being touched, and{" "}
            <code>mcp.server</code>, <code>mcp.tool</code> and{" "}
            <code>mcp.effect</code> for a call to somebody else&rsquo;s tools. A
            rule that cannot be evaluated counts as a match, so a mistyped deny
            refuses rather than quietly permitting what it was meant to forbid.
          </>
        }
        title="It may never"
      >
        {policy.deny.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No rules. Every action is allowed and recorded.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-md border border-border">
            {policy.deny.map((rule) => (
              <li
                className="flex items-center justify-between gap-4 px-3 py-2"
                key={rule}
              >
                <code className="min-w-0 break-all font-mono text-xs">
                  {rule}
                </code>
                <Button
                  disabled={saving}
                  onClick={() =>
                    void save({
                      ...policy,
                      deny: policy.deny.filter((one) => one !== rule),
                    })
                  }
                  size="sm"
                  variant="ghost"
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex gap-2">
          <Input
            aria-label="A rule, written in CEL"
            className="min-w-0 flex-1 font-mono text-xs"
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") addRule(draft);
            }}
            placeholder='tool.name == "computer_click" && contains(element.name, "submit")'
            value={draft}
          />
          <Button
            disabled={saving || draft.trim().length === 0}
            onClick={() => addRule(draft)}
            size="sm"
          >
            Add rule
          </Button>
        </div>

        <ul className="mt-3 space-y-2">
          {PRESETS.map((preset) => (
            <li className="flex items-start gap-3" key={preset.rule}>
              <Button
                className="shrink-0"
                disabled={saving || policy.deny.includes(preset.rule)}
                onClick={() => addRule(preset.rule)}
                size="sm"
                variant="outline"
              >
                {preset.label}
              </Button>
              {preset.cost ? (
                <span className="pt-1 text-xs text-muted-foreground">
                  {preset.cost}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </PageSection>

      <PageSection
        description="The floor, applied to anything the deny list did not catch. It is not a formality: an empty list here permits nothing, so a deployment that clears this refuses every action rather than allowing every action."
        title="Otherwise it may"
      >
        <ul className="mt-2 space-y-1">
          {policy.allow.map((rule) => (
            <li className="font-mono text-xs text-muted-foreground" key={rule}>
              {rule === "true" ? "true, anything not refused above" : rule}
            </li>
          ))}
        </ul>
      </PageSection>

      <p className="mt-8 text-muted-foreground text-xs">
        {problem ? (
          <span className="text-destructive" role="alert">
            {problem}
          </span>
        ) : saved ? (
          "Saved. It applies to the next action any Bot takes."
        ) : (
          "Changes apply to the next action any Bot takes, and are kept: a restart comes back up enforcing what is here."
        )}
      </p>
    </PageShell>
  );
}
