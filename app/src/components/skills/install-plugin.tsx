import {
  IconAlertTriangle,
  IconBook,
  IconChevronRight,
  IconCircleCheck,
  IconFileZip,
  IconFolderOpen,
  IconLoader2,
  IconPackage,
  IconPlug,
  IconPuzzle,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  archiveFiles,
  droppedFiles,
  folderFiles,
  PickError,
} from "@/lib/agent-plugins/files";
import {
  type InstallPlan,
  type InstallProgress,
  type InstallResult,
  installPlan,
  installPlugin,
  type ServerResult,
} from "@/lib/agent-plugins/install";
import {
  type PluginFile,
  type PluginReading,
  readPlugin,
} from "@/lib/agent-plugins/read";
import { addServerByUrlMutationOptions } from "@/lib/apps/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { saveSkillMutationOptions } from "@/lib/skills/mutations";
import { skillListQueryOptions } from "@/lib/skills/queries";
import { cn } from "@/lib/utils";

/**
 * Install a plugin, in the detail panel beside Skills: drop or choose the plugin, read what it will
 * add, then install it and finish setting up whatever needs a sign-in or a key.
 *
 * The plugin is read in the browser and installed through the two writes a person makes by hand,
 * saving a skill and adding a server by its address (`installPlugin`), so there is nothing new on
 * the server side to trust. Every skill and server is listed before anything is written, and the
 * same rows then report how each one came out, so the screen a person pressed Install on is the
 * screen that tells them what happened.
 */
export function InstallPlugin({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const skills = useQuery(skillListQueryOptions());
  const me = useQuery(currentUserQueryOptions());
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const addServer = useMutation(addServerByUrlMutationOptions(queryClient));
  const saveSkill = useMutation(saveSkillMutationOptions(queryClient));
  const [reading, setReading] = useState<PluginReading | null>(null);
  const [opening, setOpening] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const install = useMutation({
    mutationFn: (plan: InstallPlan) =>
      installPlugin(
        plan,
        {
          addServer: (input) => addServer.mutateAsync(input),
          saveSkill: (input) => saveSkill.mutateAsync(input),
        },
        setProgress,
      ),
  });

  /*
   * A server is added for the whole organization, so in the team edition only an admin adds one, as
   * on Connections → Add server. Saving under a command replaces the skill there, and `taken` is
   * what stops a plugin doing that to one of the person's own. Without the list it would be empty,
   * so nothing is installed until both reads have answered.
   */
  const personal = capabilities.data?.edition === "personal";
  const mayAddServers = personal || isOrganizationAdmin(me.data?.role);
  const taken = new Set((skills.data ?? []).map((skill) => skill.slug));
  /*
   * Held as it was when Install was pressed. The skill list refetches as each skill is saved, and a
   * plan worked out again from it would show the plugin's own new skills as already taken.
   */
  const plan =
    install.variables ??
    (reading?.ok ? installPlan(reading, taken, { mayAddServers }) : null);
  const ready = skills.data !== undefined && me.data !== undefined;

  async function open(files: Promise<PluginFile[]>) {
    setOpening(true);
    setPickError(null);
    install.reset();
    setProgress(null);
    try {
      const read = readPlugin(await files);
      setReading(read.ok ? read : null);
      if (!read.ok) setPickError(read.error);
    } catch (thrown) {
      setReading(null);
      setPickError(
        thrown instanceof PickError
          ? thrown.message
          : "That couldn't be opened. Try choosing it again.",
      );
    } finally {
      setOpening(false);
    }
  }

  const result = install.data ?? progress?.result;
  const done = install.data !== undefined;

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col gap-6 p-6">
        <header>
          <h1 className="font-semibold text-xl tracking-tight">
            Install a plugin
          </h1>
          <p className="mt-1 text-pretty text-muted-foreground text-sm leading-relaxed">
            Adds a plugin's skills and servers to OpenBot. No Bot gets them
            until you choose. Plugins use the open{" "}
            <a
              className="underline underline-offset-4 hover:text-foreground"
              href="https://agent-plugins.org/specification"
              rel="noreferrer"
              target="_blank"
            >
              Agent Plugins
            </a>{" "}
            format.
          </p>
        </header>

        {reading?.ok && plan ? (
          <>
            {done && result ? <Outcome result={result} /> : null}
            <PluginReview
              onReplace={
                install.isPending || done
                  ? undefined
                  : () => {
                      setReading(null);
                      setPickError(null);
                    }
              }
              plan={plan}
              progress={install.isPending ? progress : null}
              reading={reading}
              result={result ?? null}
            />
          </>
        ) : (
          <PluginDrop busy={opening} error={pickError} onOpen={open} />
        )}
      </div>

      {reading?.ok && plan ? (
        <footer
          className={cn(
            "sticky bottom-0 flex flex-col gap-2 border-border border-t px-6 py-4",
            // Opaque, so rows scrolling under it don't show through: the docked panel's own fill.
            "bg-background in-data-[slot=detail-pane]:bg-sidebar",
          )}
        >
          {install.error ? (
            <p className="text-destructive text-sm" role="alert">
              {install.error.message}
            </p>
          ) : null}
          {skills.error ? (
            <p className="text-destructive text-sm" role="alert">
              Couldn't read your skills, so nothing can be installed: a plugin's
              skill could replace one of yours. Try again in a moment.
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            {done ? (
              <>
                <Button
                  onClick={() => {
                    setReading(null);
                    install.reset();
                    setProgress(null);
                  }}
                  variant="ghost"
                >
                  Install another
                </Button>
                <Button onClick={onDone}>Done</Button>
              </>
            ) : (
              <>
                <Button
                  disabled={install.isPending}
                  onClick={onDone}
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button
                  disabled={
                    !ready ||
                    install.isPending ||
                    (plan.skills.length === 0 && plan.servers.length === 0)
                  }
                  onClick={() => install.mutate(plan)}
                >
                  {install.isPending ? (
                    <>
                      <IconLoader2 className="motion-safe:animate-spin" />
                      Installing…
                    </>
                  ) : (
                    "Install"
                  )}
                </Button>
              </>
            )}
          </div>
        </footer>
      ) : null}
    </div>
  );
}

/**
 * Where a plugin arrives: dropped on the box, or chosen with either button. Folders and `.zip`
 * files are both how plugins travel, and a browser's file picker can't offer both in one dialog.
 */
function PluginDrop({
  busy,
  error,
  onOpen,
}: {
  busy: boolean;
  error: string | null;
  onOpen: (files: Promise<PluginFile[]>) => void;
}) {
  const folder = useRef<HTMLInputElement>(null);
  const archive = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  // `webkitdirectory` is not in React's attribute types, though every current browser supports it.
  useEffect(() => {
    folder.current?.setAttribute("webkitdirectory", "");
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <Empty
        className={cn(
          "rounded-lg border border-border border-dashed py-10 transition-colors duration-150",
          over && "border-primary bg-primary/5",
        )}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) {
            setOver(false);
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setOver(true);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          onOpen(droppedFiles(event.dataTransfer));
        }}
      >
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {busy ? (
              <IconLoader2 className="motion-safe:animate-spin" />
            ) : (
              <IconPackage />
            )}
          </EmptyMedia>
          <EmptyTitle>
            {busy ? "Reading the plugin…" : "Drop a plugin here"}
          </EmptyTitle>
          <EmptyDescription>Its folder, or a .zip of it.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              disabled={busy}
              onClick={() => folder.current?.click()}
              size="sm"
              variant="outline"
            >
              <IconFolderOpen />
              Choose folder
            </Button>
            <Button
              disabled={busy}
              onClick={() => archive.current?.click()}
              size="sm"
              variant="outline"
            >
              <IconFileZip />
              Choose .zip
            </Button>
          </div>
        </EmptyContent>
      </Empty>
      <input
        aria-label="Plugin folder"
        className="sr-only"
        multiple
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (picked.length > 0) onOpen(folderFiles(picked));
        }}
        ref={folder}
        tabIndex={-1}
        type="file"
      />
      <input
        accept=".zip,application/zip"
        aria-label="Plugin archive"
        className="sr-only"
        onChange={(event) => {
          const picked = event.target.files?.[0];
          event.target.value = "";
          if (picked) onOpen(archiveFiles(picked));
        }}
        ref={archive}
        tabIndex={-1}
        type="file"
      />
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** What a skill or server row says on its right: nothing before Install, then how it came out. */
type RowState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; label: string }
  | { kind: "setup"; label: string; serverId?: string }
  | { kind: "failed"; label: string };

/**
 * The plugin, its skills and servers, and what won't be installed. Drawn before the install and
 * kept through it, each row's right side turning into how that row came out.
 */
export function PluginReview({
  reading,
  plan,
  progress = null,
  result = null,
  onReplace,
}: {
  reading: Extract<PluginReading, { ok: true }>;
  plan: InstallPlan;
  progress?: InstallProgress | null;
  result?: InstallResult | null;
  /** Pick another plugin. Absent while installing and after. */
  onReplace?: () => void;
}) {
  const skillState = (slug: string): RowState => {
    const done = result?.skills.find((skill) => skill.slug === slug);
    if (done) {
      return done.saved
        ? { kind: "done", label: "Saved" }
        : { kind: "failed", label: done.message ?? "Not saved." };
    }
    return progress?.working?.kind === "skill" && progress.working.key === slug
      ? { kind: "working" }
      : { kind: "idle" };
  };
  const serverState = (name: string): RowState => {
    const done = result?.servers.find((server) => server.name === name);
    if (done) return serverOutcome(done);
    return progress?.working?.kind === "server" && progress.working.key === name
      ? { kind: "working" }
      : { kind: "idle" };
  };
  const leftOut = [
    ...plan.skippedSkills.map((item) => ({ ...item, kind: "Skill" })),
    ...plan.skippedServers.map((item) => ({ ...item, kind: "Server" })),
  ];
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const adds = [
    plan.skills.length > 0 ? count(plan.skills.length, "skill") : "",
    plan.servers.length > 0 ? count(plan.servers.length, "server") : "",
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <PageRows className="mt-0">
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconPuzzle />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {reading.name}
                {reading.version ? (
                  <span className="font-normal text-muted-foreground text-xs">
                    {reading.version}
                  </span>
                ) : null}
              </ItemTitle>
              {reading.description ? (
                <ItemDescription>{reading.description}</ItemDescription>
              ) : null}
            </ItemContent>
            {onReplace ? (
              <ItemActions>
                <Button onClick={onReplace} size="sm" variant="ghost">
                  Choose another
                </Button>
              </ItemActions>
            ) : null}
          </Item>
        </PageRows>
        {/* Before the install: once it has run, the outcome above says what it came to. */}
        {result && !progress ? null : (
          <p className="mt-2 text-muted-foreground text-sm">
            {adds.length > 0
              ? `Adds ${adds.join(" and ")}.`
              : "Nothing in this plugin can be installed here."}
            {reading.format !== "agent-plugins"
              ? ` Read from its ${reading.format === "claude" ? "Claude Code" : "Codex"} manifest.`
              : ""}
          </p>
        )}
      </div>

      {plan.skills.length > 0 ? (
        <ReviewSection count={plan.skills.length} title="Skills">
          {plan.skills.map((skill, index) => (
            <div key={skill.slug}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBook />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>/{skill.slug}</ItemTitle>
                  {skill.summary ? (
                    <ItemDescription>{skill.summary}</ItemDescription>
                  ) : null}
                  <details className="group/details mt-1 text-xs">
                    <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                      <IconChevronRight className="size-3.5 transition-transform duration-150 group-open/details:rotate-90" />
                      Instructions
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-sans text-foreground text-xs leading-relaxed">
                      {skill.instructions}
                    </pre>
                    {skill.otherFiles.length > 0 ? (
                      <p className="mt-2 text-muted-foreground">
                        Not kept: {skill.otherFiles.join(", ")}
                      </p>
                    ) : null}
                  </details>
                </ItemContent>
                <RowStatus state={skillState(skill.slug)} />
              </Item>
            </div>
          ))}
        </ReviewSection>
      ) : null}

      {plan.servers.length > 0 ? (
        <ReviewSection count={plan.servers.length} title="Servers">
          {plan.servers.map((server, index) => (
            <div key={server.name}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconPlug />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle>{server.title}</ItemTitle>
                  <ItemDescription className="truncate">
                    {server.url}
                  </ItemDescription>
                </ItemContent>
                <RowStatus state={serverState(server.name)} />
              </Item>
            </div>
          ))}
        </ReviewSection>
      ) : null}

      {leftOut.length > 0 || reading.notes.length > 0 ? (
        <details className="group/left-out">
          <summary className="flex cursor-pointer select-none items-center gap-1.5 font-semibold text-sm [&::-webkit-details-marker]:hidden">
            <IconChevronRight className="size-4 text-muted-foreground transition-transform duration-150 group-open/left-out:rotate-90" />
            Won't be installed
            <span className="font-normal text-muted-foreground">
              {leftOut.length + reading.notes.length}
            </span>
          </summary>
          <ul className="mt-3 flex flex-col gap-3 pl-5.5 text-sm">
            {leftOut.map((item) => (
              <li key={`${item.kind}:${item.name}`}>
                <span className="font-medium">{item.name}</span>
                <span className="ml-2 text-muted-foreground text-xs">
                  {item.kind}
                </span>
                <p className="text-muted-foreground">{item.reason}</p>
              </li>
            ))}
            {reading.notes.map((note) => (
              <li className="text-muted-foreground" key={note}>
                {note}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ReviewSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="font-semibold text-sm">
        {title}
        <span className="ml-1.5 font-normal text-muted-foreground">
          {count}
        </span>
      </h2>
      <PageRows className="mt-2">{children}</PageRows>
    </section>
  );
}

function RowStatus({ state }: { state: RowState }) {
  if (state.kind === "idle") return null;
  return (
    <ItemActions className="max-w-[45%] justify-end text-right text-xs">
      {state.kind === "working" ? (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <IconLoader2 className="size-4 motion-safe:animate-spin" />
          Adding
        </span>
      ) : state.kind === "done" ? (
        <span className="flex items-center gap-1.5 text-success">
          <IconCircleCheck className="size-4" />
          {state.label}
        </span>
      ) : state.kind === "setup" ? (
        <Button
          render={
            // A server that was added opens on its own page, where each person signs in. One
            // refused for want of a key was never added, so it is added again with the key.
            state.serverId ? (
              <Link params={{ key: state.serverId }} to="/connections/$key" />
            ) : (
              <Link to="/connections/new" />
            )
          }
          size="sm"
          variant="outline"
        >
          {state.label}
        </Button>
      ) : (
        <span className="flex items-start gap-1.5 text-destructive">
          <IconAlertTriangle className="mt-px size-4 shrink-0" />
          {state.label}
        </span>
      )}
    </ItemActions>
  );
}

/** A server's outcome as its row says it: added, a step left to take, or why it wasn't added. */
function serverOutcome(server: ServerResult): RowState {
  switch (server.status) {
    case "added":
    case "already-added":
      return {
        kind: "done",
        label: server.status === "added" ? "Added" : "Already added",
      };
    case "sign-in":
      return {
        kind: "setup",
        label: "Finish setup",
        ...(server.serverId ? { serverId: server.serverId } : {}),
      };
    case "needs-key":
      return {
        kind: "setup",
        label: "Add a key",
        ...(server.serverId ? { serverId: server.serverId } : {}),
      };
    case "not-approved":
      return {
        kind: "failed",
        label: "Not on your admin's approved list.",
      };
    case "failed":
      return { kind: "failed", label: server.message ?? "Not added." };
  }
}

/** One line on what the install came to, read out when it lands. */
export function Outcome({ result }: { result: InstallResult }) {
  const saved = result.skills.filter((skill) => skill.saved).length;
  const is = (...statuses: ServerResult["status"][]) =>
    result.servers.filter((server) => statuses.includes(server.status)).length;
  // A server refused for want of a key was never added: it is a step left, not an install.
  const added = is("added", "already-added", "sign-in");
  const signIn = is("sign-in");
  const needsKey = is("needs-key");
  const failed = result.skills.length - saved + is("not-approved", "failed");
  const servers = (n: number) => `${n} server${n === 1 ? "" : "s"}`;
  const parts = [
    saved > 0 ? `${saved} skill${saved === 1 ? "" : "s"}` : "",
    added > 0 ? `${added} server${added === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return (
    <div
      className="rounded-lg border border-border bg-card p-4 text-sm dark:border-transparent"
      role="status"
    >
      <p className="flex items-center gap-2 font-medium">
        {failed > 0 || needsKey > 0 ? (
          <IconAlertTriangle className="size-4 text-warning" />
        ) : (
          <IconCircleCheck className="size-4 text-success" />
        )}
        {parts.length > 0
          ? `Installed ${parts.join(" and ")}.`
          : "Nothing was installed."}
      </p>
      <p className="mt-1 text-muted-foreground">
        {[
          signIn > 0
            ? `Finish setting up ${signIn === 1 ? "1 server" : servers(signIn)} by signing in before a Bot can use ${signIn === 1 ? "it" : "them"}.`
            : "",
          needsKey > 0
            ? `${servers(needsKey)} need${needsKey === 1 ? "s" : ""} a key, which an admin adds from Connections.`
            : "",
          failed > 0
            ? `${failed} couldn't be installed; each row says why.`
            : "",
          saved > 0 ? "Put a skill on a Bot from that Bot's Skills page." : "",
        ]
          .filter(Boolean)
          .join(" ")}
      </p>
    </div>
  );
}
