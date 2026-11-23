import {
  IconAlertTriangle,
  IconCheck,
  IconFolderOpen,
  IconMinus,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type InstallPlan,
  type InstallResult,
  installPlan,
  installPlugin,
  type ServerResult,
} from "@/lib/agent-plugins/install";
import {
  type LeftOut,
  type PluginFile,
  type PluginReading,
  pathInPlugin,
  readPlugin,
  wantsText,
} from "@/lib/agent-plugins/read";
import { addServerByUrlMutationOptions } from "@/lib/apps/mutations";
import { saveSkillMutationOptions } from "@/lib/skills/mutations";
import { skillListQueryOptions } from "@/lib/skills/queries";

/**
 * Install a plugin, in the detail panel beside Skills: pick the plugin's folder, read what it will
 * do, then install it.
 *
 * The plugin is read in the browser and installed through the same two writes a person makes by
 * hand, saving a skill and adding a server by its address (`installPlugin`), so there is nothing new
 * on the server side to trust. Every skill and server is listed before anything is written, with the
 * reason for each one left out.
 */
export function InstallPlugin({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const skills = useQuery(skillListQueryOptions());
  const addServer = useMutation(addServerByUrlMutationOptions(queryClient));
  const saveSkill = useMutation(saveSkillMutationOptions(queryClient));
  const [reading, setReading] = useState<PluginReading | null>(null);
  const install = useMutation({
    mutationFn: (plan: InstallPlan) =>
      installPlugin(plan, {
        addServer: (input) => addServer.mutateAsync(input),
        saveSkill: (input) => saveSkill.mutateAsync(input),
      }),
  });

  const taken = new Set((skills.data ?? []).map((skill) => skill.slug));
  const plan = reading?.ok ? installPlan(reading, taken) : null;
  const nothingToInstall =
    plan !== null && plan.skills.length === 0 && plan.servers.length === 0;
  /*
   * Saving under a command replaces the skill there, and `taken` is what stops a plugin doing that
   * to one of the person's own. Without the list it would be empty, so nothing is installed until
   * the list has been read.
   */
  const skillsUnknown = skills.data === undefined;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Install a plugin</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a plugin folder in the{" "}
          <a
            className="underline"
            href="https://agent-plugins.org/specification"
            rel="noreferrer"
            target="_blank"
          >
            Agent Plugins
          </a>{" "}
          format. Its skills become yours and its servers are added to
          Connections. No Bot gets either until you give it to one.
        </p>
      </header>

      {install.data ? (
        <InstallOutcome onDone={onDone} result={install.data} />
      ) : (
        <>
          <FolderPicker
            disabled={install.isPending}
            onPicked={(files) => {
              install.reset();
              setReading(readPlugin(files));
            }}
          />
          {reading && !reading.ok ? (
            <p className="text-destructive text-sm" role="alert">
              {reading.error}
            </p>
          ) : null}
          {reading?.ok && plan ? (
            <>
              <PluginReview plan={plan} reading={reading} />
              {install.error ? (
                <p className="text-destructive text-sm" role="alert">
                  {install.error.message}
                </p>
              ) : null}
              <div>
                <Button
                  disabled={
                    nothingToInstall || install.isPending || skillsUnknown
                  }
                  onClick={() => install.mutate(plan)}
                >
                  {install.isPending
                    ? "Installing…"
                    : `Install ${reading.name}`}
                </Button>
                {skills.error ? (
                  <p className="mt-2 text-destructive text-sm" role="alert">
                    Couldn't read your skills, so nothing can be installed: a
                    plugin's skill could replace one of yours. Try again in a
                    moment.
                  </p>
                ) : null}
                {nothingToInstall ? (
                  <p className="mt-2 text-muted-foreground text-sm">
                    Nothing in this plugin can be installed here.
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * A folder picker. The browser hands over every file under the folder with its path; only the
 * manifest, the server configs and each SKILL.md are read, so a plugin with binaries or
 * `node_modules` in it costs a listing, not a read.
 */
function FolderPicker({
  disabled,
  onPicked,
}: {
  disabled: boolean;
  onPicked: (files: PluginFile[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  // `webkitdirectory` is not in React's attribute types, though every current browser supports it.
  useEffect(() => {
    input.current?.setAttribute("webkitdirectory", "");
  }, []);

  return (
    <div>
      <input
        aria-label="Plugin folder"
        className="sr-only"
        disabled={disabled}
        multiple
        onChange={async (event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = "";
          onPicked(await pluginFiles(picked));
        }}
        ref={input}
        type="file"
      />
      <Button
        disabled={disabled}
        onClick={() => input.current?.click()}
        variant="outline"
      >
        <IconFolderOpen />
        Choose a plugin folder
      </Button>
    </div>
  );
}

/** The picked files by their path inside the plugin, with the text of the ones that are read. */
export async function pluginFiles(
  files: readonly File[],
): Promise<PluginFile[]> {
  return Promise.all(
    files.map(async (file) => {
      const path = pathInPlugin(file.webkitRelativePath || file.name);
      return { path, text: wantsText(path) ? await file.text() : null };
    }),
  );
}

/** What installing will do, all of it, before anything is written. */
export function PluginReview({
  reading,
  plan,
}: {
  reading: Extract<PluginReading, { ok: true }>;
  plan: InstallPlan;
}) {
  return (
    <div className="flex flex-col gap-5">
      <section>
        <h2 className="font-medium">
          {reading.name}
          {reading.version ? (
            <span className="ml-2 text-muted-foreground text-sm">
              {reading.version}
            </span>
          ) : null}
        </h2>
        {reading.description ? (
          <p className="text-muted-foreground text-sm">{reading.description}</p>
        ) : null}
        {reading.format !== "agent-plugins" ? (
          <p className="mt-1 text-muted-foreground text-sm">
            Read from its{" "}
            {reading.format === "claude" ? "Claude Code" : "Codex"} manifest,
            the layout before Agent Plugins.
          </p>
        ) : null}
      </section>

      <ReviewList
        empty="No skills."
        items={plan.skills.map((skill) => ({
          key: skill.slug,
          title: `/${skill.slug}`,
          detail: [
            skill.summary,
            skill.otherFiles.length > 0
              ? `Its other files aren't kept: ${skill.otherFiles.join(", ")}.`
              : "",
          ]
            .filter(Boolean)
            .join(" "),
          // What a Bot will be told, readable before it is saved: the plugin's author wrote it.
          instructions: skill.instructions,
        }))}
        leftOut={plan.skippedSkills}
        title="Skills"
      />

      <ReviewList
        empty="No servers."
        items={plan.servers.map((server) => ({
          key: server.name,
          title: server.title,
          detail: server.url,
        }))}
        leftOut={plan.skippedServers}
        title="Servers"
      />

      {reading.notes.length > 0 ? (
        <section>
          <h3 className="font-medium text-sm">Also in the folder</h3>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground text-sm">
            {reading.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ReviewList({
  title,
  items,
  leftOut,
  empty,
}: {
  title: string;
  items: {
    key: string;
    title: string;
    detail: string;
    instructions?: string;
  }[];
  leftOut: LeftOut[];
  empty: string;
}) {
  return (
    <section>
      <h3 className="font-medium text-sm">
        {title}
        <span className="ml-2 text-muted-foreground">
          {items.length} to install
          {leftOut.length > 0 ? `, ${leftOut.length} left out` : ""}
        </span>
      </h3>
      {items.length === 0 && leftOut.length === 0 ? (
        <p className="mt-1 text-muted-foreground text-sm">{empty}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {items.map((item) => (
            <Row
              detail={item.detail}
              icon={<IconCheck className="size-4 text-primary" />}
              instructions={item.instructions}
              key={item.key}
              title={item.title}
            />
          ))}
          {leftOut.map((item) => (
            <Row
              detail={item.reason}
              icon={<IconMinus className="size-4 text-muted-foreground" />}
              key={`left-out:${item.name}`}
              muted
              title={item.name}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({
  icon,
  title,
  detail,
  instructions,
  muted = false,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
  /** A skill's instructions, behind a disclosure. */
  instructions?: string;
  muted?: boolean;
}) {
  return (
    <li className="flex gap-2 text-sm">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <span className={muted ? "text-muted-foreground" : "font-medium"}>
          {title}
        </span>
        {detail ? (
          <span className="block break-words text-muted-foreground">
            {detail}
          </span>
        ) : null}
        {instructions ? (
          <details className="mt-1">
            <summary className="cursor-pointer text-muted-foreground">
              Read the instructions
            </summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border p-2 font-mono text-xs">
              {instructions}
            </pre>
          </details>
        ) : null}
      </div>
    </li>
  );
}

const SERVER_STATUS: Record<ServerResult["status"], string> = {
  added: "Added. Give its tools to a Bot from Connections.",
  "sign-in": "Added. Each person signs in to it from Connections.",
  "already-added": "Already added here.",
  "needs-key": "Needs a key, which an admin adds from Connections.",
  "not-approved": "Not on your admin's list of approved servers.",
  failed: "Not added.",
};

/** What the install came to, row by row: one failure stops nothing else, so each says its own. */
export function InstallOutcome({
  result,
  onDone,
}: {
  result: InstallResult;
  onDone: () => void;
}) {
  const ok = (status: ServerResult["status"]) =>
    status === "added" || status === "sign-in" || status === "already-added";
  return (
    <div className="flex flex-col gap-5">
      {result.skills.length > 0 ? (
        <section>
          <h3 className="font-medium text-sm">Skills</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {result.skills.map((skill) => (
              <Row
                detail={
                  skill.saved
                    ? "Saved. Put it on a Bot from the Bot's Skills."
                    : skill.message
                }
                icon={
                  skill.saved ? (
                    <IconCheck className="size-4 text-primary" />
                  ) : (
                    <IconAlertTriangle className="size-4 text-destructive" />
                  )
                }
                key={skill.slug}
                title={`/${skill.slug}`}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {result.servers.length > 0 ? (
        <section>
          <h3 className="font-medium text-sm">Servers</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {result.servers.map((server) => (
              <Row
                detail={[
                  SERVER_STATUS[server.status],
                  ok(server.status) ? "" : server.message,
                ]
                  .filter(Boolean)
                  .join(" ")}
                icon={
                  ok(server.status) ? (
                    <IconCheck className="size-4 text-primary" />
                  ) : (
                    <IconAlertTriangle className="size-4 text-destructive" />
                  )
                }
                key={server.name}
                title={server.name}
              />
            ))}
          </ul>
        </section>
      ) : null}
      <div className="flex gap-2">
        <Button onClick={onDone}>Done</Button>
        {result.servers.length > 0 ? (
          <Button render={<Link to="/connections" />} variant="ghost">
            Open Connections
          </Button>
        ) : null}
      </div>
    </div>
  );
}
