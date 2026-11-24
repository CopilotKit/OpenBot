import type { AddServerByUrlOutcome } from "@/lib/apps/mutations";
import { skillTitle } from "@/lib/learning/display";
import type { SkillInput } from "@/lib/skills/mutations";
import type { LeftOut, PluginReading, PluginServer } from "./read";

/**
 * What installing a read plugin does in OpenBot, decided before anything is written so the screen
 * can show all of it first, and then doing it.
 *
 * A plugin's skills become the person's own skills, and its servers are added the way Connections →
 * Add server adds one. Both go through the endpoints those screens already use, so ownership, the
 * MCP allowlist, the HTTPS floor and the audit trail are the ones every other skill and server gets.
 *
 * INSTALLING GIVES NO BOT ANYTHING. A new skill is on no Bot and a new server's tools are granted to
 * nobody, exactly as when a person writes a skill or adds a server by hand. Putting either on a Bot
 * stays the separate, deliberate step it is today.
 */

/** OpenBot's slug: `form.ts`'s and the server's, 2 to 40 characters. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const TITLE_MAX = 120;
const SUMMARY_MAX = 200;
const SERVER_TITLE_MAX = 60;

/** A skill the plugin ships, as OpenBot will save it. */
export type PlannedSkill = Omit<SkillInput, "tools" | "global" | "summary"> & {
  /** The skill's description, cut to the one line the `/` menu shows. */
  summary: string;
  /** The skill's other files, which OpenBot doesn't keep with a written skill. */
  otherFiles: string[];
};

export type PlannedServer = PluginServer & { title: string };

export type InstallPlan = {
  skills: PlannedSkill[];
  skippedSkills: LeftOut[];
  servers: PlannedServer[];
  skippedServers: LeftOut[];
};

/**
 * Turn a plugin's skills and servers into OpenBot's.
 *
 * `taken` is the slugs of the skills the person can already see. Saving under a slug replaces the
 * skill there, so a plugin skill whose name is taken is left out rather than allowed to overwrite
 * one somebody wrote.
 *
 * `mayAddServers` is false for somebody who isn't an admin in the team edition. A server is added
 * for the whole organization, so only an admin adds one; the plugin's servers are then shown as left
 * out with that reason, rather than tried and refused one by one.
 */
export function installPlan(
  reading: Extract<PluginReading, { ok: true }>,
  taken: ReadonlySet<string>,
  { mayAddServers = true }: { mayAddServers?: boolean } = {},
): InstallPlan {
  const skills: PlannedSkill[] = [];
  const skippedSkills = [...reading.skippedSkills];
  for (const skill of reading.skills) {
    if (!SLUG.test(skill.name)) {
      skippedSkills.push({
        name: skill.name,
        reason:
          "OpenBot's skill commands are 2 to 40 characters, so this name doesn't fit.",
      });
      continue;
    }
    if (taken.has(skill.name)) {
      skippedSkills.push({
        name: skill.name,
        reason: `You already have /${skill.name}, so it was left as it is.`,
      });
      continue;
    }
    if (skill.body === "") {
      skippedSkills.push({
        name: skill.name,
        reason: "Its SKILL.md has no instructions under its front matter.",
      });
      continue;
    }
    const summary = shortened(oneLine(skill.description), SUMMARY_MAX);
    skills.push({
      slug: skill.name,
      title: shortened(skillTitle(skill.name, skill.description), TITLE_MAX),
      summary,
      // An Agent Skill's description says when to use it. If it didn't fit the one-liner, it leads
      // the instructions, so nothing it said is lost.
      instructions:
        summary === oneLine(skill.description)
          ? skill.body
          : `${skill.description}\n\n${skill.body}`,
      otherFiles: skill.otherFiles,
    });
  }
  if (!mayAddServers) {
    return {
      skills,
      skippedSkills,
      servers: [],
      skippedServers: [
        ...reading.servers.map((server) => ({
          name: server.name,
          reason:
            "Only an admin adds a server here. Ask yours to add it from Connections.",
        })),
        ...reading.skippedServers,
      ],
    };
  }
  return {
    skills,
    skippedSkills,
    servers: reading.servers.map((server) => ({
      ...server,
      title: shortened(server.name, SERVER_TITLE_MAX),
    })),
    skippedServers: reading.skippedServers,
  };
}

/** How one server's add came out. */
export type ServerResult = {
  name: string;
  status:
    | "added"
    | "sign-in"
    | "already-added"
    | "needs-key"
    | "not-approved"
    | "failed";
  message?: string;
  /** The app it became, or was already, where known. */
  serverId?: string;
};

export type SkillResult = { slug: string; saved: boolean; message?: string };

export type InstallResult = { servers: ServerResult[]; skills: SkillResult[] };

/** Where an install is: the row being written (null once done), and what has come out so far. */
export type InstallProgress = {
  working: { kind: "server" | "skill"; key: string } | null;
  result: InstallResult;
};

/** The two writes an install makes, so the order and the failure rules are testable on their own. */
export type InstallSteps = {
  addServer: (input: {
    title: string;
    url: string;
  }) => Promise<AddServerByUrlOutcome>;
  saveSkill: (input: SkillInput) => Promise<unknown>;
};

/**
 * Install a plan: servers first, then skills.
 *
 * Servers go first so the skills can name their tools. A skill declares the tools of the servers
 * this install added, which is what lets a Bot holding many tools be offered the plugin's tools when
 * the plugin's skill matches. It grants nothing: what a Bot may call is still its grants.
 *
 * One failure stops nothing else (Agent Plugins §11.3): each server and skill reports on its own.
 * `onProgress` hears which one is being written and everything that has come out so far, so a
 * screen can mark each row as it finishes rather than wait for the whole install.
 */
export async function installPlugin(
  plan: InstallPlan,
  steps: InstallSteps,
  onProgress?: (progress: InstallProgress) => void,
): Promise<InstallResult> {
  const servers: ServerResult[] = [];
  const skills: SkillResult[] = [];
  const tell = (working: InstallProgress["working"]) =>
    onProgress?.({
      working,
      result: { servers: [...servers], skills: [...skills] },
    });
  const tools: string[] = [];
  for (const server of plan.servers) {
    tell({ kind: "server", key: server.name });
    try {
      const outcome = await steps.addServer({
        title: server.title,
        url: server.url,
      });
      if (outcome.added) {
        tools.push(...outcome.server.tools.map((tool) => tool.ref));
        servers.push({
          name: server.name,
          status: outcome.signIn ? "sign-in" : "added",
          serverId: outcome.server.id,
        });
      } else {
        servers.push({
          name: server.name,
          status:
            outcome.code ??
            (outcome.serverId ? "already-added" : ("failed" as const)),
          message: outcome.error,
          ...(outcome.serverId ? { serverId: outcome.serverId } : {}),
        });
      }
    } catch (thrown) {
      servers.push({
        name: server.name,
        status: "failed",
        message: messageOf(thrown),
      });
    }
  }

  const declared = [...new Set(tools)];
  for (const skill of plan.skills) {
    tell({ kind: "skill", key: skill.slug });
    try {
      await steps.saveSkill({
        slug: skill.slug,
        title: skill.title,
        summary: skill.summary,
        instructions: skill.instructions,
        tools: declared,
      });
      skills.push({ slug: skill.slug, saved: true });
    } catch (thrown) {
      skills.push({
        slug: skill.slug,
        saved: false,
        message: messageOf(thrown),
      });
    }
  }
  tell(null);
  return { servers, skills };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** At most `max` characters, cut at a word where there is one, ending in an ellipsis when cut. */
function shortened(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : "That didn't work.";
}
