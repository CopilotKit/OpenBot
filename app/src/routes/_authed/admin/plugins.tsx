import { IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
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
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useBotNames } from "@/lib/agents/bot-names";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { storeMcpToken } from "@/lib/credentials/mutations";
import {
  addCuratedServerMutationOptions,
  addCustomServerMutationOptions,
  refreshPluginServerMutationOptions,
  removePluginServerMutationOptions,
  removeSkillMutationOptions,
  saveSkillMutationOptions,
  setPluginGrantMutationOptions,
} from "@/lib/plugins/mutations";
import {
  type PluginServer,
  type PluginSkill,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * Account-wide plugin and skill installation, with separate per-Bot grants.
 */
export const Route = createFileRoute("/_authed/admin/plugins")({
  component: PluginsPage,
});

function PluginsPage() {
  const queryClient = useQueryClient();
  const { data, isPending, isError } = useQuery(pluginsPageQueryOptions());
  const { data: agents } = useQuery(agentListQueryOptions());
  const nameFor = useBotNames();
  const [tab, setTab] = useState<"catalogue" | "yours" | "skills">("catalogue");
  const [error, setError] = useState<string | null>(null);

  /*
   * Every write on this page reports into the same banner, so they share one failure handler rather
   * than each growing its own. `refresh` stays because two of them are chains that end in a server
   * record the catalogue reads back.
   */
  const report = { onError: (thrown: Error) => setError(thrown.message) };
  const setGrant = useMutation({
    ...setPluginGrantMutationOptions(queryClient),
    ...report,
  });
  const addCurated = useMutation({
    ...addCuratedServerMutationOptions(queryClient),
    ...report,
  });
  const addCustom = useMutation({
    ...addCustomServerMutationOptions(queryClient),
    ...report,
  });
  const refreshServer = useMutation({
    ...refreshPluginServerMutationOptions(queryClient),
    ...report,
  });
  const removeServer = useMutation({
    ...removePluginServerMutationOptions(queryClient),
    ...report,
  });
  const saveSkill = useMutation({
    ...saveSkillMutationOptions(queryClient),
    ...report,
  });
  const removeSkill = useMutation({
    ...removeSkillMutationOptions(queryClient),
    ...report,
  });

  /**
   * Adding a server is two writes: the token becomes a credential, then the record refers to it.
   * Chained here rather than in a factory because only this page knows a token was typed.
   */
  const addServerWithToken = async (
    run: (credentialId?: string) => void,
    serverId: string,
    token?: string,
  ) => {
    setError(null);
    try {
      run(await storeMcpToken(serverId, token));
    } catch (thrown) {
      setError((thrown as Error).message);
    }
  };

  const bots = (agents ?? []).map((agent: { id: string }) => ({
    id: agent.id,
    name: nameFor(agent.id),
  }));

  return (
    <PageShell
      description="What this deployment can reach, and which Bots may reach it. Adding is account-wide; enabling is per Bot."
      title="Plugins"
    >
      <PageSection>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["catalogue", "Catalogue"],
              ["yours", "Yours"],
              ["skills", "Skills"],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              onClick={() => setTab(key)}
              size="sm"
              type="button"
              variant={tab === key ? "default" : "outline"}
            >
              {label}
            </Button>
          ))}
        </div>

        {error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-6">
          {isPending ? null : isError || !data ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              Plugins could not be loaded.
            </p>
          ) : tab === "catalogue" ? (
            <Catalogue
              added={new Set(data.servers.map((server) => server.id))}
              items={data.catalogue}
              onAdd={(key, instanceHost, token) =>
                void addServerWithToken(
                  (credentialId) =>
                    addCurated.mutate({ key, instanceHost, credentialId }),
                  key,
                  token,
                )
              }
              onAddCustom={(input) =>
                void addServerWithToken(
                  (credentialId) =>
                    addCustom.mutate({ ...input, credentialId }),
                  input.id,
                  input.token,
                )
              }
            />
          ) : tab === "yours" ? (
            <Yours
              bots={bots}
              onGrant={(ref, agentId, held) =>
                setGrant.mutate({
                  agentId,
                  granted: !held,
                  kind: "mcp",
                  ref,
                })
              }
              onRefresh={(id) => refreshServer.mutate(id)}
              onRemove={(id) => removeServer.mutate(id)}
              servers={data.servers}
            />
          ) : (
            <Skills
              bots={bots}
              onGrant={(slug, agentId, held) =>
                setGrant.mutate({
                  agentId,
                  granted: !held,
                  kind: "skill",
                  ref: slug,
                })
              }
              // Admin-authored skills are deployment-global; personal skills are created elsewhere.
              onInstall={(input) =>
                saveSkill.mutate({ ...input, global: true })
              }
              onUninstall={(slug) => removeSkill.mutate(slug)}
              skills={data.skills}
            />
          )}
        </div>
      </PageSection>
    </PageShell>
  );
}

function Catalogue({
  items,
  added,
  onAdd,
  onAddCustom,
}: {
  items: {
    key: string;
    title: string;
    vendor: string;
    summary: string;
    docsUrl: string;
    needsCredential: boolean;
    perInstance: boolean;
  }[];
  added: Set<string>;
  onAdd: (key: string, instanceHost?: string, token?: string) => void;
  onAddCustom: (input: {
    id: string;
    title: string;
    url: string;
    token?: string;
  }) => void;
}) {
  const [instanceHost, setInstanceHost] = useState<Record<string, string>>({});
  const [token, setToken] = useState<Record<string, string>>({});
  const [addingCustom, setAddingCustom] = useState(false);
  const [custom, setCustom] = useState({
    id: "",
    title: "",
    url: "",
    token: "",
  });

  return (
    <div className="space-y-6">
      {/*
       * ONE COLUMN, like every other list in the app. Two columns meant the eye had to choose a
       * side and then come back for the other, on a page whose whole job is "what can this
       * deployment reach" — a question answered by reading down a list once.
       */}
      <div className="flex flex-col gap-3">
        {items.map((item) => (
          <div
            className="rounded-lg border border-border bg-card p-4"
            key={item.key}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">{item.title}</div>
                <p className="text-sm text-muted-foreground">{item.summary}</p>
              </div>
              <Button
                className="shrink-0"
                disabled={added.has(item.key)}
                onClick={() =>
                  onAdd(
                    item.key,
                    instanceHost[item.key] || undefined,
                    token[item.key] || undefined,
                  )
                }
                size="sm"
                type="button"
                variant="outline"
              >
                {added.has(item.key) ? "Added" : "Add"}
              </Button>
            </div>
            {item.perInstance ? (
              <Input
                aria-label={`Instance host for ${item.title}`}
                className="mt-2"
                onChange={(event) =>
                  setInstanceHost((current) => ({
                    ...current,
                    [item.key]: event.target.value,
                  }))
                }
                placeholder="https://your-instance.service-now.com"
                value={instanceHost[item.key] ?? ""}
              />
            ) : null}
            {item.needsCredential ? (
              /* Mask tokens before they are stored in the credential vault. */
              <Input
                aria-label={`Access token for ${item.title}`}
                className="mt-2"
                onChange={(event) =>
                  setToken((current) => ({
                    ...current,
                    [item.key]: event.target.value,
                  }))
                }
                placeholder="Access token for this server"
                type="password"
                value={token[item.key] ?? ""}
              />
            ) : null}
            <a
              className="mt-2 inline-block text-xs text-muted-foreground underline"
              href={item.docsUrl}
              rel="noreferrer"
              target="_blank"
            >
              Vendor documentation
            </a>
          </div>
        ))}
      </div>

      <div className="flex justify-start">
        <Button onClick={() => setAddingCustom(true)} size="sm" variant="ghost">
          <IconPlus />
          Add a server by URL
        </Button>
      </div>

      <Dialog onOpenChange={setAddingCustom} open={addingCustom}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a server by URL</DialogTitle>
            <DialogDescription>
              For a server that is not in the catalogue. Nobody has reviewed it,
              so every tool it offers is treated as one that changes something,
              and the server is recorded as custom wherever it appears.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="custom-id">Name</FieldLabel>
                <Input
                  id="custom-id"
                  onChange={(event) =>
                    setCustom((current) => ({
                      ...current,
                      id: event.target.value,
                    }))
                  }
                  placeholder="name (lower-case)"
                  value={custom.id}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="custom-title">Title</FieldLabel>
                <Input
                  id="custom-title"
                  onChange={(event) =>
                    setCustom((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                  placeholder="Title"
                  value={custom.title}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="custom-url">URL</FieldLabel>
                <Input
                  id="custom-url"
                  onChange={(event) =>
                    setCustom((current) => ({
                      ...current,
                      url: event.target.value,
                    }))
                  }
                  placeholder="https://mcp.example.com/mcp"
                  value={custom.url}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="custom-token">
                  Access token, if it needs one
                </FieldLabel>
                <Input
                  id="custom-token"
                  onChange={(event) =>
                    setCustom((current) => ({
                      ...current,
                      token: event.target.value,
                    }))
                  }
                  type="password"
                  value={custom.token}
                />
              </Field>
            </FieldGroup>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setAddingCustom(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={!(custom.id && custom.title && custom.url)}
              onClick={() => {
                onAddCustom(custom);
                setCustom({ id: "", title: "", url: "", token: "" });
                setAddingCustom(false);
              }}
              size="sm"
            >
              Add server
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Plugin server summary shown in the admin grant table. */
function Yours({
  servers,
  bots,
  onGrant,
  onRefresh,
  onRemove,
}: {
  servers: PluginServer[];
  bots: { id: string; name: string }[];
  onGrant: (ref: string, agentId: string, held: boolean) => void;
  onRefresh: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (servers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No servers added yet. The Catalogue tab is where they come from.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {/*
       * The two words beside each tool decide how it is judged, and neither said so anywhere.
       * "changes things" is not a description of the tool, it is the effect the boundary evaluates,
       * and somebody writing a rule about writes has no way to know that from the badge alone.
       */}
      <p className="max-w-prose text-muted-foreground text-sm leading-relaxed">
        A Bot with a grant may call that tool; a Bot without one is never told
        it exists. Beside each tool is what it does to the far end, which is
        what a boundary rule means by <code>mcp.effect</code>. Anything not
        positively known to be read-only counts as <span>changes things</span>,
        so every tool on a server somebody added by URL is treated as a write
        until it is reviewed. Every call is checked against the boundary and
        written to Audit whichever way it goes.
      </p>
      {servers.map((server) => (
        <div
          className="rounded-lg border border-border bg-card"
          key={server.id}
        >
          <div className="flex items-start justify-between gap-3 border-border border-b px-4 py-3">
            <div>
              <div className="flex items-center gap-2 font-medium">
                {server.title}
                {server.provenance === "custom" ? (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-500">
                    custom
                  </span>
                ) : null}
              </div>
              <div className="font-mono text-muted-foreground text-xs">
                {server.url}
              </div>
              {server.lastError ? (
                <div className="mt-1 text-xs text-destructive">
                  {server.lastError}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                onClick={() => onRefresh(server.id)}
                size="sm"
                type="button"
                variant="outline"
              >
                Refresh tools
              </Button>
              <Button
                onClick={() => onRemove(server.id)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Remove
              </Button>
            </div>
          </div>

          {/*
           * A ROW PER TOOL, NOT A GRID OF TOOLS AGAINST BOTS. The matrix put one checkbox column per
           * Bot, so it grew a column every time somebody made a Bot and was already scrolling
           * sideways at four of them — and sideways is where a grant quietly goes unread. The
           * toggles wrap under the tool they belong to instead, which is how grants are shown
           * everywhere else in the app.
           */}
          {server.tools.length === 0 ? (
            <p className="px-4 py-3 text-muted-foreground text-sm">
              No tools listed. Refresh to ask the server again.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {server.tools.map((tool) => (
                <div className="px-4 py-3" key={tool.ref}>
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-xs">{tool.name}</span>
                    <span
                      className={
                        tool.effect === "write"
                          ? "text-amber-600 text-xs dark:text-amber-500"
                          : "text-muted-foreground text-xs"
                      }
                    >
                      {tool.effect === "write" ? "changes things" : "reads"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-muted-foreground text-xs">
                    {tool.description}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {bots.map((bot) => {
                      const held = tool.grantedTo.includes(bot.id);
                      return (
                        <Button
                          key={bot.id}
                          onClick={() => onGrant(tool.ref, bot.id, held)}
                          size="sm"
                          type="button"
                          variant={held ? "default" : "outline"}
                        >
                          {bot.name}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Packaged `/` instructions installed at deployment scope and granted per Bot. */
function Skills({
  skills,
  bots,
  onInstall,
  onUninstall,
  onGrant,
}: {
  skills: PluginSkill[];
  bots: { id: string; name: string }[];
  onInstall: (input: {
    slug: string;
    title: string;
    summary: string;
    instructions: string;
  }) => void;
  onUninstall: (slug: string) => void;
  onGrant: (slug: string, agentId: string, held: boolean) => void;
}) {
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState({
    slug: "",
    title: "",
    summary: "",
    instructions: "",
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-start">
        <Button onClick={() => setWriting(true)} size="sm" variant="ghost">
          <IconPlus />
          Write a skill
        </Button>
      </div>

      <Dialog onOpenChange={setWriting} open={writing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Write a skill for the deployment</DialogTitle>
            <DialogDescription>
              The slug is what a person types after a slash, and the
              instructions are added to the run when they do. Everybody here can
              use it, and you decide which Bots have it. People write their own
              on the Skills page.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="skill-slug">Slug</FieldLabel>
                <Input
                  id="skill-slug"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      slug: event.target.value,
                    }))
                  }
                  placeholder="standup-notes"
                  value={draft.slug}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="skill-title">Title</FieldLabel>
                <Input
                  id="skill-title"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                  placeholder="Title"
                  value={draft.title}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="skill-summary">Summary</FieldLabel>
                <Input
                  id="skill-summary"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      summary: event.target.value,
                    }))
                  }
                  placeholder="One line"
                  value={draft.summary}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="skill-instructions">
                  Instructions
                </FieldLabel>
                <Textarea
                  className="h-28 font-mono text-sm"
                  id="skill-instructions"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      instructions: event.target.value,
                    }))
                  }
                  placeholder="What the Bot should do when this skill is used."
                  value={draft.instructions}
                />
              </Field>
            </FieldGroup>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setWriting(false)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={!(draft.slug && draft.title && draft.instructions)}
              onClick={() => {
                onInstall(draft);
                setDraft({
                  slug: "",
                  title: "",
                  summary: "",
                  instructions: "",
                });
                setWriting(false);
              }}
              size="sm"
            >
              Install skill
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {skills.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No skills installed yet.
        </p>
      ) : (
        /* Rows, for the same reason the tool grants are rows: a column per Bot does not scale. */
        <div className="rounded-lg border border-border bg-card">
          {skills.map((skill, index) => (
            <React.Fragment key={skill.slug}>
              <div className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <code className="font-mono text-foreground/80 text-xs">
                      /{skill.slug}
                    </code>
                    <span className="font-medium text-sm">{skill.title}</span>
                    {skill.ownerUserId ? (
                      <span className="rounded-md bg-foreground/5 px-1.5 py-0.5 font-medium text-muted-foreground text-xs">
                        {skill.installedBy ?? "somebody"}
                      </span>
                    ) : null}
                  </div>
                  <Button
                    onClick={() => onUninstall(skill.slug)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Remove
                  </Button>
                </div>
                {skill.summary ? (
                  <p className="mt-0.5 text-muted-foreground text-xs">
                    {skill.summary}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  {bots.map((bot) => {
                    const held = skill.grantedTo.includes(bot.id);
                    return (
                      <Button
                        key={bot.id}
                        onClick={() => onGrant(skill.slug, bot.id, held)}
                        size="sm"
                        type="button"
                        variant={held ? "default" : "outline"}
                      >
                        {bot.name}
                      </Button>
                    );
                  })}
                </div>
              </div>
              {index !== skills.length - 1 && <Separator />}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
