import {
  IconChevronRight,
  IconLock,
  IconPlus,
  IconShieldCheck,
} from "@tabler/icons-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

/**
 * One value from a fixed set of labelled choices: a rule's behaviour, or how commands on a computer
 * are handled. The keys of `labels` are the values, in the order they are offered.
 */
export function LabelSelect<T extends string>({
  id,
  label,
  labels,
  value,
  disabled,
  onChange,
}: {
  id?: string;
  /** The trigger's accessible name, where no visible label names it. */
  label?: string;
  labels: Record<T, string>;
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next as T);
      }}
      value={value}
    >
      <SelectTrigger aria-label={label} id={id}>
        <SelectValue>{labels[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(labels) as T[]).map((key) => (
          <SelectItem key={key} value={key}>
            {labels[key]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The behaviours a team rule is offered under, each saying it is the team's. */
const TEAM_BEHAVIOUR_LABELS = Object.fromEntries(
  Object.entries(BEHAVIOUR_LABELS).map(([key, label]) => [
    key,
    `${label} (team rule)`,
  ]),
) as Record<RuleBehaviour, string>;

/**
 * One saved rule, as a row: what it matches, and what a Bot does about it. A locked rule — a team
 * rule seen by a member, or a personal rule the team has switched off — states its behaviour and
 * offers nothing to change.
 */
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
  const labels = team ? TEAM_BEHAVIOUR_LABELS : BEHAVIOUR_LABELS;
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {locked ? <IconLock /> : <IconShieldCheck />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {rule.toolRef}
          {rule.effect !== "*" ? `, ${rule.effect}` : ""}
          {rule.scope !== "*" ? ` on ${rule.scope}` : ""}
          {rule.botId !== "*" ? ` for ${rule.botId}` : ""}
        </ItemTitle>
        {locked ? <ItemDescription>Locked</ItemDescription> : null}
      </ItemContent>
      <ItemActions>
        {locked ? (
          <span className="text-muted-foreground text-sm">
            {labels[rule.behaviour]}
          </span>
        ) : (
          <>
            <LabelSelect
              disabled={disabled}
              label={`Behaviour for ${rule.toolRef}`}
              labels={labels}
              onChange={onChange}
              value={rule.behaviour}
            />
            <Button
              disabled={disabled}
              onClick={onRevoke}
              size="sm"
              variant="outline"
            >
              Remove
            </Button>
          </>
        )}
      </ItemActions>
    </Item>
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
 * An action class and a behaviour, added from a row that opens a dialog. `*` matches anything, so
 * `mcp/gmail/*` is every Gmail tool and a target of `*.example.com` is every page on that site.
 */
export function RuleForm({
  label,
  pending,
  onSave,
  botField = true,
  forBot,
}: {
  label: string;
  pending: boolean;
  onSave: (input: ApprovalRuleInput) => void;
  /** Off where the rule applies to every Bot, so there is no Bot to name. */
  botField?: boolean;
  /** The Bot every rule from this form is for, already known from the page it is on. */
  forBot?: string;
}) {
  const blank = forBot ? { ...EMPTY_RULE, botId: forBot } : EMPTY_RULE;
  const [rule, setRule] = useState<ApprovalRuleInput>(blank);
  const [open, setOpen] = useState(false);
  const id = useId();
  // Closing without saving drops what was typed, so the dialog opens blank next time.
  const close = () => {
    setOpen(false);
    setRule(blank);
  };
  const field = (key: keyof ApprovalRuleInput, title: string, hint: string) => (
    <Field>
      <FieldLabel htmlFor={`${id}-${key}`}>{title}</FieldLabel>
      <Input
        id={`${id}-${key}`}
        onChange={(event) => {
          // Read before the updater runs: React restores a controlled input's DOM value first.
          const value = event.target.value;
          setRule((prior) => ({ ...prior, [key]: value }));
        }}
        placeholder={hint}
        value={rule[key]}
      />
    </Field>
  );
  return (
    <>
      <Item
        render={<button onClick={() => setOpen(true)} type="button" />}
        size="sm"
      >
        <ItemMedia variant="icon">
          <IconPlus />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{label}</ItemTitle>
          <ItemDescription>
            A tool or app, and what a Bot does before using it.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        open={open}
      >
        {/*
         * The popup is the form, so Save in the footer submits it and Enter in any field does too,
         * while the body stays a direct child of the popup and keeps scrolling between the two.
         */}
        <DialogContent
          render={
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onSave(rule);
                close();
              }}
            />
          }
        >
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              * matches anything, so mcp/gmail/* is every Gmail tool and a
              target of *.example.com is every page on that site.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <FieldGroup>
              {field(
                "toolRef",
                "Tool or app",
                "mcp/gmail/*, computer_click, host/*",
              )}
              {field("effect", "Kind of action", "* , write, read, delegate")}
              {field("scope", "Target", "*, a site, a folder, a Bot name")}
              {botField ? field("botId", "Bot", "* for every Bot") : null}
              <Field>
                <FieldLabel htmlFor={`${id}-behaviour`}>Behaviour</FieldLabel>
                <LabelSelect
                  id={`${id}-behaviour`}
                  labels={BEHAVIOUR_LABELS}
                  onChange={(behaviour) =>
                    setRule((prior) => ({ ...prior, behaviour }))
                  }
                  value={rule.behaviour}
                />
              </Field>
            </FieldGroup>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={close} size="sm" variant="outline">
              Cancel
            </Button>
            <Button
              disabled={pending || !rule.toolRef.trim()}
              size="sm"
              type="submit"
            >
              Save rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
