import {
  IconChevronRight,
  IconDeviceDesktop,
  IconEye,
  IconId,
  IconNotes,
  IconPlugConnected,
  IconShieldCheck,
  IconTag,
  IconTextCaption,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import type { ZodType } from "zod";
import { CallbackTokenPanel } from "@/components/agents/callback-token-panel";
import { DefaultModelSection } from "@/components/bot-profile/default-model";
import { BusinessComputerLink } from "@/components/edition/team-features-dialog";
import { PageRows, PageSection } from "@/components/layout/page-shell";
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
  agentEndpointSchema,
  agentFormSchema,
  profileUpdateInput,
} from "@/lib/agents/form";
import {
  ISOLATED_MAKING_PUBLIC,
  ISOLATED_PUBLIC_SHARES_LOGINS,
  ISOLATION_NOT_ALLOWED,
  ISOLATION_WITHDRAWN,
  isolatedExplained,
  isolationGone,
  isolationUnavailable,
} from "@/lib/agents/isolation";
import { updateAgentMutationOptions } from "@/lib/agents/mutations";
import { publicVisibilityWords } from "@/lib/agents/public-words";
import type { AgentProfile } from "@/lib/agents/queries";
import { shownSubtitle } from "@/lib/agents/subtitle";
import { isComposing } from "@/lib/composing";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { myCapabilitiesQueryOptions } from "@/lib/enterprise/queries";
import { useOrganizationAudience } from "@/lib/organizations/queries";
import { queryClient } from "@/query-client";

type TextField = "name" | "title" | "roleDescription" | "instructions";

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
    // The starter Bot is the exception: this is what it does, for the person, and what it is
    // told is the row below.
    label: "What it does",
    icon: IconTextCaption,
    multiline: true,
  },
  {
    // Only the starter Bot has this row. See `AgentProfile.instructions`.
    field: "instructions",
    label: "Instructions",
    icon: IconNotes,
    multiline: true,
  },
];

const TEXT_SCHEMAS: Record<TextField, ZodType<string>> = {
  name: agentFormSchema.shape.name,
  title: agentFormSchema.shape.title,
  roleDescription: agentFormSchema.shape.roleDescription,
  instructions: agentFormSchema.shape.instructions.unwrap(),
};

/** Who a Bot is and where it runs. Editable by whoever may manage it; read-only for everyone else. */
export function SetupSections({ agent }: { agent: AgentProfile }) {
  // One person and one shared computer: nobody to see a Bot, and no computer of its own to give it.
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const update = useMutation(updateAgentMutationOptions(queryClient));
  const [editing, setEditing] = useState<TextField | "endpoint" | null>(null);
  const save = (patch: Partial<AgentFormValues>) =>
    update.mutateAsync({
      agentId: agent.id,
      input: profileUpdateInput(agent, patch),
    });
  const open = TEXT_FIELDS.find((entry) => entry.field === editing);
  /*
   * The subtitle as a person reads it everywhere else (lib/agents/subtitle.ts). Saved back unchanged,
   * it stays as stored: the Bot is told the stored subtitle, and a save of the shown wording would
   * change that.
   */
  const shown = (field: TextField) =>
    field === "title" ? shownSubtitle(agent.title) : agent[field];
  const saveText = (field: TextField, value: string) =>
    save({
      [field]:
        field === "title" && value === shownSubtitle(agent.title)
          ? agent.title
          : value,
    });
  const fields = TEXT_FIELDS.filter(
    ({ field }) =>
      field !== "instructions" || typeof agent.instructions === "string",
  );

  return (
    <>
      <PageSection title="Identity">
        <PageRows>
          {fields.map(({ field, label, icon: Icon }, index) => (
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
                  <ItemDescription>{shown(field)}</ItemDescription>
                </ItemContent>
                {agent.canManage ? (
                  <ItemActions>
                    <IconChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                ) : null}
              </Item>
            </Fragment>
          ))}
          {personal ? (
            <>
              <Separator />
              <Item size="sm">
                <ItemContent>
                  <BusinessComputerLink />
                </ItemContent>
              </Item>
            </>
          ) : (
            <>
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
            </>
          )}
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
      <ConnectionSection
        agent={agent}
        onEditEndpoint={() => setEditing("endpoint")}
      />
      {agent.defaultModel !== undefined ? (
        <DefaultModelSection
          agent={agent}
          onSave={(defaultModel) =>
            update.mutateAsync({
              agentId: agent.id,
              input: { ...profileUpdateInput(agent, {}), defaultModel },
            })
          }
          saving={update.isPending}
        />
      ) : null}
      {open ? (
        <EditTextDialog
          label={open.label}
          multiline={open.multiline ?? false}
          onClose={() => setEditing(null)}
          onSave={(value) => saveText(open.field, value)}
          schema={TEXT_SCHEMAS[open.field]}
          value={shown(open.field) ?? ""}
        />
      ) : null}
      {editing === "endpoint" ? (
        <EditTextDialog
          address
          description="This Bot’s replies come from the agent at this address."
          label="Agent URL"
          multiline={false}
          onClose={() => setEditing(null)}
          // The same address saved back changes nothing, so it is not sent to be checked again.
          onSave={async (endpoint) => {
            if (endpoint !== agent.endpoint) await save({ endpoint });
          }}
          schema={agentEndpointSchema}
          value={agent.endpoint ?? ""}
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
  // Public is everyone in this organization, by name where the app knows it.
  const everyone = publicVisibilityWords(useOrganizationAudience());
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
                ? `${everyone} ${ISOLATED_PUBLIC_SHARES_LOGINS}`
                : everyone)}
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
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const { data: mine } = useQuery(myCapabilitiesQueryOptions());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = capabilities?.isolatedBots ?? false;
  // OpenBot Cloud gives each person one computer; the row says so and where a Bot can have its own.
  const cloud = capabilities?.hostedSignIn === true;
  const allowed = mine?.capabilities.isolatedComputers !== false;
  const isPublic = agent.visibility === "public";
  // A Bot that comes with OpenBot belongs to nobody, and the switch is a person's.
  const editable =
    agent.canManage &&
    !agent.systemOwned &&
    (agent.isolated || (available && allowed));

  // Whether the row says this OpenBot can't give a Bot a computer of its own.
  const deploymentCant = agent.isolated
    ? !agent.isolationActive && agent.isolationOffReason === "deployment"
    : !available;
  const summary = agent.systemOwned
    ? "Comes with OpenBot, so it runs on the computer of whoever is using it."
    : agent.isolated
      ? agent.isolationActive
        ? isolatedExplained(isPublic)
        : agent.isolationOffReason === "admin"
          ? ISOLATION_WITHDRAWN
          : agent.isolationOffReason === "deployment"
            ? isolationGone(cloud)
            : sharedSummary(isPublic)
      : !available
        ? isolationUnavailable(cloud)
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
        {cloud && deploymentCant && !agent.systemOwned && !error ? (
          <BusinessComputerLink className="text-xs" />
        ) : null}
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
 *
 * What is wrong shows under the field, whether this check or the server's refusal found it, and
 * the field is marked invalid and described by it only while it is shown, so a screen reader reads
 * it with the field and not before anything went wrong. `address` is a web address: the URL
 * keyboard, monospace like the row it edits, and nothing corrected as it is typed.
 */
function EditTextDialog({
  label,
  description,
  value,
  multiline,
  address = false,
  schema,
  onSave,
  onClose,
}: {
  label: string;
  description?: string;
  value: string;
  multiline: boolean;
  address?: boolean;
  schema: ZodType<string>;
  onSave: (value: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const [field, setField] = useState<
    HTMLInputElement | HTMLTextAreaElement | null
  >(null);
  const refuse = (message: string) => {
    setError(message);
    field?.focus();
  };
  const submit = async () => {
    const parsed = schema.safeParse(draft);
    if (!parsed.success) {
      refuse(
        parsed.error.issues[0]?.message ?? "Check this field and try again.",
      );
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed.data);
      onClose();
    } catch (failure) {
      refuse(
        failure instanceof Error
          ? failure.message
          : "Couldn't save. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };
  const invalid = error
    ? { "aria-invalid": true, "aria-describedby": errorId }
    : {};
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {/*
         * The body scrolls, so it clips what is drawn outside it: 4px of padding above and below keep
         * the field's focus and error rings whole, and the margins are 4px less to keep the gaps.
         */}
        <DialogBody className="mt-3 grid gap-2 py-1">
          {multiline ? (
            <Textarea
              aria-label={label}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              ref={setField}
              rows={5}
              value={draft}
              {...invalid}
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
              ref={setField}
              value={draft}
              {...invalid}
              {...(address
                ? {
                    autoCapitalize: "off",
                    autoComplete: "off",
                    autoCorrect: "off",
                    className: "font-mono",
                    inputMode: "url" as const,
                    spellCheck: false,
                    type: "url",
                  }
                : {})}
            />
          )}
          {error ? (
            <p className="text-destructive text-sm" id={errorId} role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-3">
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
 * The address a Bot connected from outside OpenBot answers at, for the developer who connected it.
 * A Bot that runs inside OpenBot has no such section: what runs it is not the person's concern, and
 * there is nothing to connect.
 *
 * Whoever manages the Bot can move it to another address: the row opens a dialog, like the Identity
 * rows above it.
 */
function ConnectionSection({
  agent,
  onEditEndpoint,
}: {
  agent: AgentProfile;
  onEditEndpoint: () => void;
}) {
  if (!agent.endpoint || agent.builtIn) return null;
  const editable = agent.canManage;
  return (
    <PageSection title="Connection">
      <PageRows>
        <Item
          render={
            editable ? (
              <button onClick={onEditEndpoint} type="button" />
            ) : undefined
          }
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconPlugConnected />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Agent URL</ItemTitle>
            <ItemDescription className="line-clamp-none break-all font-mono">
              {agent.endpoint}
            </ItemDescription>
          </ItemContent>
          {editable ? (
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          ) : null}
        </Item>
      </PageRows>
      {agent.canManage ? (
        <CallbackTokenPanel
          agentId={agent.id}
          hasToken={agent.hasCallbackToken}
          fromOpenBot={agent.keyFromOpenBot === true}
        />
      ) : null}
    </PageSection>
  );
}
