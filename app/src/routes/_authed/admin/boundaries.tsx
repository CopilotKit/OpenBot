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
  ask: string[];
  allow: string[];
};

type Preset = { label: string; rule: string; cost?: string };

/**
 * Presets are concrete CEL rules, not a separate policy language.
 */
const PRESETS: Preset[] = [
  {
    label: "Never submit a form",
    // Three doors, not two. `key` exists only on keypress actions, so it is guarded by tool name to
    // keep the rule evaluable elsewhere; `submit` is on every action and needs no guard.
    rule: '(intent == "activate" && contains(element.name, "submit")) || (tool.name == "computer_key" && key == "Enter") || submit',
    cost: "Also stops the Bot pressing Enter for anything else, because a form submits from Enter in any of its fields.",
  },
  {
    label: "Never type into a password field",
    rule: 'intent == "type" && contains(element.name, "password")',
    cost: "A password box the page labels something else is not covered, the rule matches the label.",
  },
  {
    label: "Stop a Bot repeating itself",
    // The count includes the attempt being decided, so this refuses the tenth, not the eleventh.
    rule: "repeat.count >= 10",
    cost: "Two calls count as the same call when the thing acted on is the same, whatever was typed into it, so a Bot running ten searches from one box, or reading one file ten times, is refused on the tenth. It misses the other way too: a Bot slow enough to spread its attempts wider than a few minutes is never caught, one that changes a single argument each time is ten different calls, and calls to another server's tools are not counted at all. Worth adding while a match is recorded and allowed, before it starts refusing anybody's work.",
  },
  {
    label: "Stay off social media",
    rule: 'intent == "navigate" && (contains(page.host, "facebook.com") || contains(page.host, "x.com"))',
    cost: "Only the two hosts named. A link that redirects there from somewhere else is allowed.",
  },
];

/**
 * The same rules a deployment might otherwise have had to forbid outright.
 *
 * Both of these are things a Bot is genuinely useful for and that nobody wants it doing unwatched
 * the first few times, which is the whole shape of this list: the boundary an operator actually
 * wants is rarely "never", it is "not without me".
 */
const ASK_PRESETS: Preset[] = [
  {
    label: "Ask before submitting a form",
    rule: '(intent == "activate" && contains(element.name, "submit")) || (tool.name == "computer_key" && key == "Enter") || submit',
    cost: "Asks about every Enter the Bot presses, because a form submits from Enter in any of its fields. Expect to be asked while it is filling one in, not only at the end.",
  },
  {
    label: "Ask before writing a file outside notes/",
    rule: 'intent == "write_file" && !matches(file.path, "^notes/")',
    cost: "Matches on the path the Bot asked for, so a folder it has not used before is a question rather than a refusal.",
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
  const [askDraft, setAskDraft] = useState("");

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

  /**
   * The same rule can sit in both lists, and the deny wins.
   *
   * Not prevented, because an operator moving a rule from one list to the other will pass through
   * that state, and refusing to save it would look like a bug. What it means is stated under the
   * list instead, since the gateway decides deny first and an ask alongside it never fires.
   */
  const addAskRule = (rule: string) => {
    const trimmed = rule.trim();
    if (!trimmed || policy.ask.includes(trimmed)) return;
    void save({ ...policy, ask: [...policy.ask, trimmed] });
    setAskDraft("");
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

      <PageSection title="Ask me first">
        {policy.ask.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No rules. Nothing stops to ask.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-md border border-border">
            {policy.ask.map((rule) => (
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
                      ask: policy.ask.filter((one) => one !== rule),
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
            aria-label="A rule that asks a person first, written in CEL"
            className="min-w-0 flex-1 font-mono text-xs"
            onChange={(event) => {
              setAskDraft(event.target.value);
              setSaved(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") addAskRule(askDraft);
            }}
            placeholder='intent == "write_file" && !matches(file.path, "^notes/")'
            value={askDraft}
          />
          <Button
            disabled={saving || askDraft.trim().length === 0}
            onClick={() => addAskRule(askDraft)}
            size="sm"
          >
            Add rule
          </Button>
        </div>

        <ul className="mt-3 space-y-2">
          {ASK_PRESETS.map((preset) => (
            <li className="flex items-start gap-3" key={preset.rule}>
              <Button
                className="shrink-0"
                disabled={saving || policy.ask.includes(preset.rule)}
                onClick={() => addAskRule(preset.rule)}
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

        <p className="mt-3 text-xs text-muted-foreground">
          The Bot stops and waits where one of these matches, and carries on
          with the same action if somebody allows it. Checked after the rules
          above and before the ones below, so something you have forbidden stays
          forbidden and is never offered as a question. In{" "}
          <span className="font-medium">Record it and allow it</span> nothing
          stops: a match is recorded as a question that would have been asked.
        </p>
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
