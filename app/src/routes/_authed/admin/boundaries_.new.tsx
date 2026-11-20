import {
  IconCheck,
  IconCode,
  IconShieldX,
  IconSparkles,
} from "@tabler/icons-react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  DescribeRule,
  type WrittenRule,
} from "@/components/boundaries/describe-rule";
import { RulePreview } from "@/components/boundaries/rule-preview";
import { RuleReading } from "@/components/boundaries/rule-reading";
import {
  PageCard,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
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
import { Textarea } from "@/components/ui/textarea";
import {
  RULE_ATTRIBUTES,
  RULE_TEMPLATES,
  type RuleTemplate,
} from "@/lib/boundaries/rules";
import { isComposing } from "@/lib/composing";
import { saveActionPolicyMutationOptions } from "@/lib/computers/mutations";
import {
  type ActionPolicy,
  actionPolicyQueryOptions,
  policyDryRunQueryOptions,
} from "@/lib/computers/queries";

export const Route = createFileRoute("/_authed/admin/boundaries_/new")({
  component: NewRulePage,
});

const BACK = {
  label: "Boundaries",
  linkProps: { to: "/admin/boundaries" as const },
};

/** How long the rule has to rest before it is replayed, so typing it is not a request per keystroke. */
const PREVIEW_DELAY_MS = 400;

type Start = RuleTemplate | "describe" | "custom";

/**
 * Adding a rule: describe it, pick a template or write one, see what it would have stopped, then
 * add it.
 *
 * A template fills the form rather than adding itself, so its name, its cost and the rule it is
 * made of are all read before it applies to every Bot. A description does the same: the model's rule
 * lands in the CEL field beside an independent reading of it, and only Add rule saves it. What the
 * rule would have stopped is worked out as it is written, over a Bot's computer actions and its app
 * calls alike, so its reach is on screen before Add rule rather than behind a button somebody may
 * never press.
 */
function NewRulePage() {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const stored = useQuery(actionPolicyQueryOptions());
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));
  const [chosen, setChosen] = useState<Start | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rule, setRule] = useState("");
  const [written, setWritten] = useState<WrittenRule | null>(null);
  /*
   * What a written rule last put in Name and What it stops. A field still holding it is ours to
   * replace when the rule is written again; anything else in it is the admin's, and stays.
   */
  const [filled, setFilled] = useState({ name: "", description: "" });
  const [problem, setProblem] = useState<string | null>(null);

  const policy = stored.data;
  const trimmed = rule.trim();
  const duplicate = Boolean(policy?.deny.includes(trimmed));
  /*
   * The model's rule, unedited, that the compiler refused. Its error is already under the rule, from
   * the writing, so it is neither replayed nor offered to Add rule.
   */
  const broken = Boolean(
    written && !written.compile.ok && written.rule.trim() === trimmed,
  );
  const ready = Boolean(
    policy && name.trim() && trimmed && !duplicate && !broken,
  );

  /*
   * The rule as it stood a moment ago, debounced as People's search is. A template's rule arrives
   * whole, and is replayed as soon as it rests.
   */
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSettled(trimmed), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);

  /*
   * This rule on its own, with everything else allowed, replayed over recent recorded actions.
   * Nothing is saved. Every action it would refuse that went through is one this rule would have
   * stopped, and nothing else is.
   *
   * Not the policy in force plus this rule. Replayed against what happened, that also refuses every
   * action a rule added since then stops, and they were listed here as this rule's: a rule about
   * password fields "would have stopped" the Salesforce writes the rule before it now stops. The
   * labels are left out too: nothing evaluates them, and a renamed rule needs no new answer.
   */
  const candidate: ActionPolicy | null =
    policy && settled && !policy.deny.includes(settled) && !broken
      ? { mode: policy.mode, deny: [settled], allow: ["true"] }
      : null;
  const preview = useQuery({
    ...policyDryRunQueryOptions(
      candidate ?? { mode: "enforce", deny: [], allow: [] },
    ),
    enabled: candidate !== null,
    // The last answer stays up while the next loads, so the list does not blink between keystrokes.
    placeholderData: keepPreviousData,
  });

  const choose = (next: Start) => {
    setChosen(next);
    setProblem(null);
    setWritten(null);
    setFilled({ name: "", description: "" });
    if (next === "custom" || next === "describe") {
      setName("");
      setDescription("");
      setRule("");
    } else {
      setName(next.name);
      setDescription(next.description);
      setRule(next.rule);
    }
  };

  /* The model's rule goes into the CEL field, where the preview picks it up as it would any rule. */
  const takeWritten = (next: WrittenRule) => {
    setWritten(next);
    setRule(next.rule);
    const ours = (value: string, last: string) =>
      !value.trim() || value === last;
    const nextName = next.text.slice(0, 80);
    const nextDescription = next.summary?.slice(0, 300) ?? "";
    const takeName = ours(name, filled.name);
    const takeDescription =
      Boolean(nextDescription) && ours(description, filled.description);
    if (takeName) setName(nextName);
    if (takeDescription) setDescription(nextDescription);
    setFilled({
      name: takeName ? nextName : filled.name,
      description: takeDescription ? nextDescription : filled.description,
    });
  };

  const add = () => {
    if (!policy || !ready) return;
    setProblem(null);
    savePolicy.mutate(
      {
        ...policy,
        deny: [...policy.deny, trimmed],
        labels: {
          ...policy.labels,
          [trimmed]: { name: name.trim(), description: description.trim() },
        },
        ...(written
          ? { authoring: { source: "english" as const, text: written.text } }
          : {}),
      },
      {
        onError: (thrown: Error) => setProblem(thrown.message),
        onSuccess: () => void navigate({ to: "/admin/boundaries" }),
      },
    );
  };

  const options: { key: string; value: Start }[] = [
    { key: "describe", value: "describe" },
    ...RULE_TEMPLATES.map((template) => ({
      key: template.rule,
      value: template,
    })),
    { key: "custom", value: "custom" },
  ];

  return (
    <PageShell
      backButton={BACK}
      description="Define an action that no Bot may take. This boundary applies to every Bot’s next action."
      title="Add rule"
    >
      <PageSection title="Start from">
        <PageRows>
          {options.map((option, index) => {
            const custom = option.value === "custom";
            const describe = option.value === "describe";
            const template =
              custom || describe ? null : (option.value as RuleTemplate);
            const selected = chosen === option.value;
            const taken = template
              ? policy?.deny.includes(template.rule)
              : false;
            return (
              <div key={option.key}>
                <Item
                  aria-pressed={selected}
                  render={<button disabled={taken} type="button" />}
                  onClick={() => choose(option.value)}
                  size="sm"
                >
                  <ItemMedia variant="icon">
                    {describe ? (
                      <IconSparkles />
                    ) : custom ? (
                      <IconCode />
                    ) : (
                      <IconShieldX />
                    )}
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      {template
                        ? template.name
                        : describe
                          ? "Describe it in words"
                          : "Write your own"}
                    </ItemTitle>
                    <ItemDescription>
                      {template
                        ? taken
                          ? "Already one of your rules."
                          : template.description
                        : describe
                          ? "Say what no Bot may do, and your model writes the rule."
                          : "Describe the action yourself, in CEL."}
                    </ItemDescription>
                  </ItemContent>
                  {selected ? (
                    <ItemActions>
                      <IconCheck className="size-4" />
                    </ItemActions>
                  ) : null}
                </Item>
                {index !== options.length - 1 && <Separator />}
              </div>
            );
          })}
        </PageRows>
      </PageSection>

      {chosen ? (
        <PageSection title="The rule">
          <form
            className="mt-4"
            noValidate
            onKeyDown={(event) => {
              // Enter in a field submits the form, but not the Enter that confirms a composed
              // character: that would add a rule whose name is still half typed.
              if (event.key === "Enter" && isComposing(event))
                event.preventDefault();
            }}
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <PageCard
              footer={
                <>
                  <Button
                    render={(props) => (
                      <Link {...props} to="/admin/boundaries" />
                    )}
                    variant="outline"
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={!ready || savePolicy.isPending}
                    type="submit"
                  >
                    {savePolicy.isPending ? "Adding…" : "Add rule"}
                  </Button>
                </>
              }
            >
              <FieldGroup>
                {chosen === "describe" ? (
                  <DescribeRule onWritten={takeWritten} />
                ) : null}
                <Field>
                  <FieldLabel htmlFor="rule-name">Name</FieldLabel>
                  <Input
                    id="rule-name"
                    maxLength={80}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Never delete files"
                    value={name}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="rule-description">
                    What it stops
                  </FieldLabel>
                  <FieldDescription>
                    One sentence, shown under the name in the list.
                  </FieldDescription>
                  <Input
                    id="rule-description"
                    maxLength={300}
                    onChange={(event) => setDescription(event.target.value)}
                    value={description}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="rule-expression">Rule</FieldLabel>
                  <FieldDescription>
                    Written in CEL. OpenBot checks the rule before it's added,
                    so a typo can't stop every action.
                  </FieldDescription>
                  <Textarea
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="min-h-20 font-mono text-xs"
                    id="rule-expression"
                    onChange={(event) => setRule(event.target.value)}
                    placeholder='tool.name == "computer_click" && contains(element.name, "delete")'
                    spellCheck={false}
                    value={rule}
                  />
                  {duplicate ? (
                    <p className="text-destructive text-sm">
                      This rule is already in place.
                    </p>
                  ) : null}
                  {chosen !== "custom" && chosen !== "describe" ? (
                    <p className="text-amber-600 text-sm dark:text-amber-500">
                      {chosen.cost}
                    </p>
                  ) : null}
                  {written ? (
                    <RuleReading rule={rule} written={written} />
                  ) : null}
                  <RuleReference />
                </Field>
                {trimmed && candidate && !duplicate ? (
                  <RulePreview preview={preview} />
                ) : null}
              </FieldGroup>

              {/*
               * A save refused for the reason the preview already gives under the rule says nothing
               * twice: the sentence is on screen, beside the rule it is about.
               */}
              {problem && problem !== preview.error?.message ? (
                <p className="mt-5 text-destructive text-sm" role="alert">
                  {problem}
                </p>
              ) : null}
            </PageCard>
          </form>
        </PageSection>
      ) : null}
    </PageShell>
  );
}

/**
 * What a rule can check, folded away until it is wanted. It used to be the page's description, a
 * paragraph of attribute names read by everybody to find out what the screen was for.
 */
function RuleReference() {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        What a rule can check
      </summary>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        {RULE_ATTRIBUTES.map((attribute) => (
          <div className="contents" key={attribute.name}>
            <dt>
              <code className="font-mono text-xs">{attribute.name}</code>
            </dt>
            <dd className="text-muted-foreground">{attribute.meaning}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-muted-foreground">
        A rule that names something an action doesn't have, such as{" "}
        <code className="font-mono text-xs">key</code> on a click, counts as a
        match. Name the tool first so the rest is only checked where it applies:{" "}
        <code className="font-mono text-xs">
          tool.name == "computer_key" && key == "Enter"
        </code>
        .
      </p>
    </details>
  );
}
