import { IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
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
import {
  type PluginServer,
  type PluginSkill,
  pluginKeys,
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

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: pluginKeys.all });

  const post = async (path: string, body: unknown) => {
    setError(null);
    const response = await fetch(`/api/plugins${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(detail?.error ?? "That did not work.");
    }
    return response.json();
  };

  /**
   * Store the token as a credential first; plugin server records keep only the credential id.
   */
  const storeToken = async (
    serverId: string,
    token?: string,
  ): Promise<string | undefined> => {
    if (!token?.trim()) return undefined;
    const response = await fetch("/api/admin/credentials", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "mcp",
        provider: serverId,
        keyId: `mcp-${serverId}`,
        plaintext: token.trim(),
        metadata: { server: serverId },
      }),
    });
    if (!response.ok) {
      throw new Error("The token could not be stored.");
    }
    return (await response.json())?.credential?.id;
  };

  const mutate = useMutation({
    mutationFn: async (action: () => Promise<unknown>) => action(),
    onSuccess: refresh,
    onError: (thrown: Error) => setError(thrown.message),
  });

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
          {isPending ? (
            <PageEmpty>Loading plugins…</PageEmpty>
          ) : isError || !data ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              Plugins could not be loaded.
            </p>
          ) : tab === "catalogue" ? (
            <Catalogue
              added={new Set(data.servers.map((server) => server.id))}
              items={data.catalogue}
              onAdd={(key, instanceHost, token, oauthClient) =>
                mutate.mutate(async () => {
                  const credentialId = await storeToken(key, token);
                  const server = await post("/servers", {
                    key,
                    instanceHost,
                    credentialId,
                  });
                  /*
                   * The client is registered after the server exists, because it is recorded against
                   * that row. Two calls rather than one field on the first, matching the server: a
                   * client is rotated without the server being re-added.
                   */
                  if (oauthClient) {
                    await post(`/servers/${key}/oauth-client`, oauthClient);
                  }
                  return server;
                })
              }
              redirectUri={data.redirectUri}
              onAddCustom={(input) =>
                mutate.mutate(async () => {
                  const credentialId = await storeToken(input.id, input.token);
                  return post("/servers/custom", { ...input, credentialId });
                })
              }
            />
          ) : tab === "yours" ? (
            <Yours
              bots={bots}
              onGrant={(ref, agentId, held) =>
                mutate.mutate(() =>
                  held
                    ? fetch(
                        `/api/plugins/grants?kind=mcp&ref=${encodeURIComponent(ref)}&agentId=${encodeURIComponent(agentId)}`,
                        { method: "DELETE", credentials: "include" },
                      )
                    : post("/grants", { kind: "mcp", ref, agentId }),
                )
              }
              onRefresh={(id) =>
                mutate.mutate(() => post(`/servers/${id}/refresh`, {}))
              }
              onRemove={(id) =>
                mutate.mutate(() =>
                  fetch(`/api/plugins/servers/${encodeURIComponent(id)}`, {
                    method: "DELETE",
                    credentials: "include",
                  }),
                )
              }
              servers={data.servers}
            />
          ) : (
            <Skills
              bots={bots}
              onGrant={(slug, agentId, held) =>
                mutate.mutate(() =>
                  held
                    ? fetch(
                        `/api/plugins/grants?kind=skill&ref=${encodeURIComponent(slug)}&agentId=${encodeURIComponent(agentId)}`,
                        { method: "DELETE", credentials: "include" },
                      )
                    : post("/grants", { kind: "skill", ref: slug, agentId }),
                )
              }
              // Admin-authored skills are deployment-global; personal skills are created elsewhere.
              onInstall={(input) =>
                mutate.mutate(() => post("/skills", { ...input, global: true }))
              }
              onUninstall={(slug) =>
                mutate.mutate(() =>
                  fetch(`/api/plugins/skills/${encodeURIComponent(slug)}`, {
                    method: "DELETE",
                    credentials: "include",
                  }),
                )
              }
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
  redirectUri,
}: {
  items: {
    key: string;
    title: string;
    vendor: string;
    summary: string;
    docsUrl: string;
    /**
     * Whose credential reaches this server.
     *
     * `deployment-bearer` is the only one an administrator can satisfy by typing a token here.
     * `user-oauth` is reached as whoever is asking, so there is no token for this page to collect.
     */
    auth: "none" | "deployment-bearer" | "user-oauth";
    perInstance: boolean;
  }[];
  added: Set<string>;
  onAdd: (
    key: string,
    instanceHost?: string,
    token?: string,
    oauthClient?: { clientId: string; clientSecret: string },
  ) => void;
  /** What to register with a user-oauth vendor. Null when this deployment has no public URL. */
  redirectUri: string | null;
  onAddCustom: (input: {
    id: string;
    title: string;
    url: string;
    token?: string;
  }) => void;
}) {
  const [instanceHost, setInstanceHost] = useState<Record<string, string>>({});
  const [token, setToken] = useState<Record<string, string>>({});
  const [client, setClient] = useState<
    Record<string, { clientId: string; clientSecret: string }>
  >({});
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
                    item.auth === "user-oauth" &&
                      client[item.key]?.clientId &&
                      client[item.key]?.clientSecret
                      ? client[item.key]
                      : undefined,
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
            {item.auth === "user-oauth" ? (
              /*
               * A client, not a token. Nobody's documents are reachable with what is typed here: it
               * identifies this deployment to the vendor, and each person then consents for
               * themselves in their own settings. Worth saying on the screen, because "client
               * secret" in a box on an admin page looks exactly like the credential above it and is
               * a very different thing.
               */
              <div className="mt-3 space-y-2 rounded-md bg-muted/40 p-3">
                <p className="text-muted-foreground text-xs">
                  {item.title} answers as whoever is asking. Register this
                  deployment's OAuth client here; everybody then connects their
                  own account from Preferences.
                </p>
                <Input
                  aria-label={`OAuth client ID for ${item.title}`}
                  onChange={(event) =>
                    setClient((current) => ({
                      ...current,
                      [item.key]: {
                        clientId: event.target.value,
                        clientSecret: current[item.key]?.clientSecret ?? "",
                      },
                    }))
                  }
                  placeholder="OAuth client ID"
                  value={client[item.key]?.clientId ?? ""}
                />
                <Input
                  aria-label={`OAuth client secret for ${item.title}`}
                  onChange={(event) =>
                    setClient((current) => ({
                      ...current,
                      [item.key]: {
                        clientId: current[item.key]?.clientId ?? "",
                        clientSecret: event.target.value,
                      },
                    }))
                  }
                  placeholder="OAuth client secret"
                  type="password"
                  value={client[item.key]?.clientSecret ?? ""}
                />
                {redirectUri ? (
                  <div>
                    <p className="text-muted-foreground text-xs">
                      Add this to the client's authorised redirect URIs, exactly
                      as written:
                    </p>
                    {/*
                     * Selectable and monospaced, because it is copied by hand into somebody else's
                     * console and a single wrong character fails at the vendor with a message that
                     * does not mention us.
                     */}
                    <code className="mt-1 block select-all break-all rounded bg-background px-2 py-1 font-mono text-xs">
                      {redirectUri}
                    </code>
                  </div>
                ) : (
                  <p className="text-destructive text-xs" role="alert">
                    This deployment has no public URL, so nobody can complete a
                    consent flow. Set OPENBOT_PUBLIC_URL and restart.
                  </p>
                )}
              </div>
            ) : null}
            {item.auth === "deployment-bearer" ? (
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
