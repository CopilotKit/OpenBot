import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * CEL computer-action boundary editor. Rules are shown as the gateway evaluates them, and denied
 * actions are recorded in Audit with the matching rule.
 */

type PolicyMode = "dry-run" | "enforce";

type ActionPolicy = {
  mode: PolicyMode;
  deny: string[];
  allow: string[];
};

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
    label: "Let a scheduled run look, never press",
    // `run.unattended` is true for a routine on its schedule and for a webhook delivery, and false
    // whenever somebody is at the screen, so the same Bot keeps working normally in a conversation.
    rule: 'run.unattended && intent == "activate"',
    cost: "A routine can browse, read and write notes, and cannot press anything at all — including a Next button it needs to get past a page it was only going to read.",
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
  const [policy, setPolicy] = useState<ActionPolicy | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/computers/policy", {
        credentials: "include",
      });
      if (!response.ok) {
        setProblem("The boundary could not be read.");
        return;
      }
      const body = (await response.json()) as { policy: ActionPolicy };
      setPolicy(body.policy);
      setProblem(null);
    } catch {
      setProblem("The boundary could not be reached.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (next: ActionPolicy) => {
    setSaving(true);
    setSaved(false);
    try {
      const response = await fetch("/api/computers/policy", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      const body = (await response.json().catch(() => null)) as {
        policy?: ActionPolicy;
        error?: string;
      } | null;
      if (!response.ok) {
        setProblem(body?.error ?? "The boundary could not be saved.");
        return;
      }
      // Display the persisted policy in case the server normalized it.
      if (body?.policy) setPolicy(body.policy);
      setProblem(null);
      setSaved(true);
    } catch {
      setProblem("The boundary could not be reached.");
    } finally {
      setSaving(false);
    }
  }, []);

  if (problem && !policy) {
    return (
      <PageShell title="Boundaries">
        <p className="mt-4 text-destructive text-sm" role="alert">
          {problem}
        </p>
      </PageShell>
    );
  }

  if (!policy) {
    return (
      <PageShell title="Boundaries">
        <p className="mt-4 text-muted-foreground text-sm">
          Loading the boundary…
        </p>
      </PageShell>
    );
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
      <PageSection title="When a rule matches">
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

      <PageSection title="It may never">
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

      <PageSection title="Otherwise it may">
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
