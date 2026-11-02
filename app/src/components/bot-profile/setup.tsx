import {
  IconChevronRight,
  IconDeviceDesktop,
  IconEye,
  IconId,
  IconPlugConnected,
  IconShieldCheck,
  IconTag,
  IconTextCaption,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import type { ZodType } from "zod";
import { CallbackTokenPanel } from "@/components/agents/callback-token-panel";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentFormValues,
  agentFormSchema,
  profileUpdateInput,
} from "@/lib/agents/form";
import {
  ISOLATED_MAKING_PUBLIC,
  ISOLATED_PUBLIC_SHARES_LOGINS,
  ISOLATION_GONE,
  ISOLATION_NOT_ALLOWED,
  ISOLATION_UNAVAILABLE,
  ISOLATION_WITHDRAWN,
  isolatedExplained,
} from "@/lib/agents/isolation";
import { updateAgentMutationOptions } from "@/lib/agents/mutations";
import {
  type AgentProfile,
  agentCapabilitiesQueryOptions,
} from "@/lib/agents/queries";
import { isComposing } from "@/lib/composing";
import { myCapabilitiesQueryOptions } from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";

type TextField = "name" | "title" | "roleDescription";

const TEXT_FIELDS: {
  field: TextField;
  label: string;
  icon: typeof IconId;
  multiline?: boolean;
}[] = [
  { field: "name", label: "Name", icon: IconId },
  { field: "title", label: "Title", icon: IconTag },
  {
    field: "roleDescription",
    // Not "Role": beside "Title" it read as a second job title, when it is the standing
    // instruction the Bot carries into every channel. The create dialog says the same.
    label: "What it does",
    icon: IconTextCaption,
    multiline: true,
  },
];

/** Who a Bot is and where it runs. Editable by whoever may manage it; read-only for everyone else. */
export function SetupSections({ agent }: { agent: AgentProfile }) {
  const update = useMutation(updateAgentMutationOptions(queryClient));
  const [editing, setEditing] = useState<TextField | null>(null);
  const save = (patch: Partial<AgentFormValues>) =>
    update.mutateAsync({
      agentId: agent.id,
      input: profileUpdateInput(agent, patch),
    });
  const open = TEXT_FIELDS.find((entry) => entry.field === editing);

  return (
    <>
      <PageSection title="Identity">
        <PageRows>
          {TEXT_FIELDS.map(({ field, label, icon: Icon }, index) => (
            <Fragment key={field}>
              {index > 0 ? <Separator /> : null}
              <Item
                render={
                  agent.canManage ? (
                    <button onClick={() => setEditing(field)} type="button" />
                  ) : undefined
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <Icon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{label}</ItemTitle>
                  <ItemDescription>{agent[field]}</ItemDescription>
                </ItemContent>
                {agent.canManage ? (
                  <ItemActions>
                    <IconChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                ) : null}
              </Item>
            </Fragment>
          ))}
          <Separator />
          <VisibilityRow
            agent={agent}
            onSave={(visibility) => save({ visibility })}
          />
          <Separator />
          <IsolatedRow
            agent={agent}
            onSave={(isolated) => save({ isolated })}
          />
          {agent.systemOwned ? (
            <>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconShieldCheck />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>System owned</ItemTitle>
                  <ItemDescription>
                    Comes with OpenBot. It doesn't belong to a person.
                  </ItemDescription>
                </ItemContent>
              </Item>
            </>
          ) : null}
        </PageRows>
      </PageSection>
      <ConnectionSection agent={agent} />
      {open ? (
        <EditTextDialog
          label={open.label}
          multiline={open.multiline ?? false}
          onClose={() => setEditing(null)}
          onSave={(value) => save({ [open.field]: value })}
          schema={agentFormSchema.shape[open.field]}
          value={agent[open.field]}
        />
      ) : null}
    </>
  );
}

/** Two named choices that write on pick: no draft worth holding, so no dialog. */
function VisibilityRow({
  agent,
  onSave,
}: {
  agent: AgentProfile;
  onSave: (visibility: AgentProfile["visibility"]) => Promise<unknown>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconEye />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Visibility</ItemTitle>
        <ItemDescription>
          {error ??
            (agent.visibility === "private"
              ? agent.isolationActive
                ? `Only you can see it and start conversations with it. ${ISOLATED_MAKING_PUBLIC}`
                : "Only you can see it and start conversations with it."
              : agent.isolationActive
                ? `Everyone on OpenBot can find and use it. ${ISOLATED_PUBLIC_SHARES_LOGINS}`
                : "Everyone on OpenBot can find and use it.")}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {agent.canManage ? (
          <Select
            disabled={saving}
            // The label map, so the closed trigger says "Private" rather than the raw value.
            items={{ private: "Private", public: "Public" }}
            onValueChange={async (next) => {
              if (next === agent.visibility) return;
              setError(null);
              setSaving(true);
              try {
                await onSave(next as AgentProfile["visibility"]);
              } catch (failure) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Couldn't save. Try again.",
                );
              } finally {
                setSaving(false);
              }
            }}
            value={agent.visibility}
          >
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="private">Private</SelectItem>
              <SelectItem value="public">Public</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <span className="text-muted-foreground text-sm">
            {agent.visibility === "private" ? "Private" : "Public"}
          </span>
        )}
      </ItemActions>
    </Item>
  );
}

/**
 * Whether it has a computer of its own: a switch that writes when flipped, like Visibility's choice.
 *
 * The switch shows what the owner asked for. What is actually happening is the description, decided
 * by the server: a Bot whose owner lost "Isolated Bots" keeps its tick, runs on their shared computer,
 * and says so here, so that an administrator giving the switch back restores it without anybody
 * touching the Bot.
 *
 * Turning it off is never refused, so the switch stays live for an isolated Bot even where it could
 * not be turned back on. Turning it on is offered only where the deployment can make the computer
 * and the person holds the switch; anywhere else the row says which of the two is missing.
 */
function IsolatedRow({
  agent,
  onSave,
}: {
  agent: AgentProfile;
  onSave: (isolated: boolean) => Promise<unknown>;
}) {
  const { data: capabilities } = useQuery(agentCapabilitiesQueryOptions());
  const { data: mine } = useQuery(myCapabilitiesQueryOptions());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = capabilities?.isolationAvailable ?? false;
  const allowed = mine?.capabilities.isolatedComputers !== false;
  const isPublic = agent.visibility === "public";
  // A Bot that comes with OpenBot belongs to nobody, and the switch is a person's.
  const editable =
    agent.canManage &&
    !agent.systemOwned &&
    (agent.isolated || (available && allowed));

  const summary = agent.systemOwned
    ? "Comes with OpenBot, so it runs on the computer of whoever is using it."
    : agent.isolated
      ? agent.isolationActive
        ? isolatedExplained(isPublic)
        : agent.isolationOffReason === "admin"
          ? ISOLATION_WITHDRAWN
          : agent.isolationOffReason === "deployment"
            ? ISOLATION_GONE
            : sharedSummary(isPublic)
      : !available
        ? ISOLATION_UNAVAILABLE
        : !allowed && agent.canManage
          ? ISOLATION_NOT_ALLOWED
          : sharedSummary(isPublic);

  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconDeviceDesktop />
      </ItemMedia>
      <ItemContent>
        <ItemTitle id={`isolated-${agent.id}`}>Isolated</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {error ?? summary}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {agent.canManage && !agent.systemOwned ? (
          <Switch
            aria-labelledby={`isolated-${agent.id}`}
            checked={agent.isolated}
            disabled={saving || !editable}
            onCheckedChange={async (next) => {
              setError(null);
              setSaving(true);
              try {
                await onSave(next);
              } catch (failure) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Couldn't save. Try again.",
                );
              } finally {
                setSaving(false);
              }
            }}
          />
        ) : (
          <span className="text-muted-foreground text-sm">
            {agent.isolated ? "On" : "Off"}
          </span>
        )}
      </ItemActions>
    </Item>
  );
}

/** Where a Bot without a computer of its own runs: on the computer of whoever is using it. */
function sharedSummary(isPublic: boolean): string {
  return isPublic
    ? "Runs on the computer of whoever is using it."
    : "Runs on your computer, alongside your other Bots.";
}

/**
 * One text field in a dialog, validated against the same limits the server enforces. Enter saves a
 * single-line field — but not the Enter that confirms a composed character, which would save the
 * value before the person finished typing it.
 */
function EditTextDialog({
  label,
  value,
  multiline,
  schema,
  onSave,
  onClose,
}: {
  label: string;
  value: string;
  multiline: boolean;
  schema: ZodType<string>;
  onSave: (value: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const parsed = schema.safeParse(draft);
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? "Check this field and try again.",
      );
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed.data);
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't save. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 grid gap-2">
          {multiline ? (
            <Textarea
              aria-label={label}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              rows={5}
              value={draft}
            />
          ) : (
            <Input
              aria-label={label}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !isComposing(event)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              value={draft}
            />
          )}
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            disabled={saving}
            onClick={onClose}
            size="sm"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void submit()} size="sm">
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Where it runs. A built-in Bot runs on the deployment's own Bot, whose process already holds the
 * deployment's tool credential, so there is nothing to show but that sentence.
 */
function ConnectionSection({ agent }: { agent: AgentProfile }) {
  const builtIn = !agent.endpoint || agent.builtIn;
  return (
    <PageSection title="Connection">
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconPlugConnected />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{builtIn ? "Built in" : "Agent URL"}</ItemTitle>
            <ItemDescription
              className={
                builtIn ? undefined : "line-clamp-none break-all font-mono"
              }
            >
              {builtIn
                ? "Runs inside OpenBot. There's nothing to connect."
                : agent.endpoint}
            </ItemDescription>
          </ItemContent>
        </Item>
      </PageRows>
      {!builtIn && agent.canManage ? (
        <CallbackTokenPanel
          agentId={agent.id}
          hasToken={agent.hasCallbackToken}
        />
      ) : null}
    </PageSection>
  );
}
