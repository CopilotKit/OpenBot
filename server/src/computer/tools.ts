/**
 * The computer tools, declared once and executed on the server.
 *
 * WHAT THIS CHANGES. These were registered in the browser with `useFrontendTool`, and every handler
 * was a `fetch` back to `/api/computers/:botId/...` — a round trip into this same process. That made
 * an open tab load-bearing. A Bot whose person had closed the window had no browser, no workspace
 * and no shell, because the only thing that could carry out a tool call had gone away, and an
 * unattended run was out of reach entirely.
 *
 * The repository has already made this move once, for a different tool family, and said why:
 *
 * > The loop used to run in the browser: every MCP tool was registered with `useFrontendTool` and
 * > its handler posted back to `/api/plugins/call`. That made a browser a hard requirement for a Bot
 * > to do anything, which rules out an embedded widget, a run nobody is watching, and any surface
 * > that is not our own app.  — `plugins/tools.ts`
 *
 * NOTHING ABOUT GOVERNANCE MOVES WITH IT, for the same reason it did not move for MCP. Every acting
 * tool still goes through `ComputerGateway`, which resolves the ref against the snapshot this server
 * took, evaluates the policy, writes the audit row, and only then acts. This module hands the model a
 * description of what it may call; the gateway remains what decides whether a call happens.
 *
 * WHAT DELIBERATELY STAYS IN THE BROWSER IS RENDERING. The transcript still draws these calls, and
 * still names the element the gateway resolved rather than the ref the model sent, because the
 * result shape below is the one those renderers already parse. They register with
 * `useRenderToolCall`, which draws a call without claiming to execute it.
 *
 * WHAT ALSO STAYS IN THE BROWSER, AND WHY. `computer_request_secret` and `computer_request_help` are
 * not here. Both end with a person typing into a masked box or taking the wheel, so both need
 * somebody present by definition; moving them would produce a tool that a headless run can call and
 * can never have answered. A run with nobody watching is not left mute by their absence — it still
 * holds `ask_person`, which is the honest exit for a Bot that needs a human and has no browser
 * attached to reach one through.
 *
 * A `GrantedTool` rather than a new shape, because that is already this codebase's word for "a tool
 * the model may call, executed here". `escalation.ts` and `handoff-tool.ts` build them without going
 * anywhere near a plugin grant, so the type is the tool interface rather than the plugin interface.
 */

import { z } from "zod";
import type { GrantedTool } from "../plugins/tools";
import {
  ComputerUnavailableError,
  ElementNotFoundError,
  NavigationRefusedError,
  StaleSnapshotError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
} from "./client";
import {
  type ActionActor,
  ActionRefusedError,
  type ComputerGateway,
} from "./gateway";

export type ComputerToolsContext = {
  gateway: ComputerGateway;
  /** The Bot whose computer this is. The gateway addresses the computer by the same id. */
  botId: string;
  /** Whose authorization the call carries. The audit row names them, not the Bot alone. */
  actor: ActionActor;
  /**
   * Records a Bot's self-reported refusal.
   *
   * Absent leaves `report_refusal` recording nothing, which is the correct behaviour for a
   * deployment with no audit store rather than a reason to withhold the tool: a Bot that has
   * declined something should still be able to say so in the transcript.
   */
  recordRefusal?: (input: {
    botId: string;
    actor: ActionActor;
    reason: string;
    request?: string;
  }) => Promise<void>;
};

/**
 * What a tool answers with.
 *
 * JSON rather than prose, because two readers consume it: the model, which does better with named
 * fields than with a sentence it has to parse, and the transcript renderer in the browser, which
 * already reads exactly this shape. `ok` is first because the one thing both readers must not have
 * to infer is whether the thing happened.
 */
export type ToolOutcome = Record<string, unknown> & { ok: boolean };

const answer = (outcome: ToolOutcome) => JSON.stringify(outcome);

/**
 * Every way a computer call can fail, as something a model can act on.
 *
 * WHY EACH IS SEPARATE. A model handed "an error occurred" retries the identical call, and a model
 * handed "your refs are stale" takes a fresh snapshot. The distinction between a refusal it must
 * not retry, a stale reference it should re-read, and a computer that is simply not there is the
 * difference between a Bot that recovers and one that loops until its step cap.
 *
 * A refusal returns the rule's own words. "The agent declined" is exactly the sentence this
 * product exists to replace: an operator must be able to see which rule said no.
 */
function outcomeForError(error: unknown): ToolOutcome {
  if (error instanceof ActionRefusedError) {
    return {
      ok: false,
      refused: true,
      reason: error.message,
      ...(error.rule ? { rule: error.rule } : {}),
    };
  }
  if (error instanceof StaleSnapshotError) {
    return {
      ok: false,
      stale: true,
      reason:
        "The page changed since that snapshot. Call computer_snapshot again and use the new refs.",
    };
  }
  if (error instanceof ElementNotFoundError) {
    return {
      ok: false,
      reason:
        "Nothing on the page matches that ref. Take a fresh snapshot and use a ref from it.",
    };
  }
  if (error instanceof NavigationRefusedError) {
    return { ok: false, refused: true, reason: error.message };
  }
  if (error instanceof ComputerUnavailableError) {
    return {
      ok: false,
      unavailable: true,
      reason:
        "Your computer is not available right now, so nothing was done. Say so rather than retrying.",
    };
  }
  if (
    error instanceof WorkspaceRefusedError ||
    error instanceof WorkspaceRequestError
  ) {
    return { ok: false, refused: true, reason: error.message };
  }
  return {
    ok: false,
    reason: error instanceof Error ? error.message : "That did not work.",
  };
}

/** Run one gateway call, turning every failure into an outcome the model can read. */
async function attempt(work: () => Promise<unknown>): Promise<string> {
  try {
    const result = (await work()) as Record<string, unknown> | undefined;
    return answer({ ok: true, ...(result ?? {}) });
  } catch (error) {
    return answer(outcomeForError(error));
  }
}

/**
 * One tool, with its arguments validated before the gateway is touched.
 *
 * Validated here rather than trusted, because these arguments are model output: a `ref` that is a
 * number and a `snapshotId` that is a string are both things a model does, and the gateway would
 * refuse them somewhere deeper with a message written for a developer rather than for the model
 * that has to correct itself.
 */
function tool<Schema extends z.ZodType>(
  name: string,
  description: string,
  parameters: Schema,
  run: (args: z.infer<Schema>) => Promise<unknown>,
): GrantedTool {
  return {
    name,
    ref: `computer/${name}`,
    description,
    parameters,
    execute: async (args: unknown) => {
      const parsed = parameters.safeParse(args ?? {});
      if (!parsed.success) {
        return answer({
          ok: false,
          reason: `Those arguments are not right for ${name}: ${parsed.error.issues
            .map(
              (issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`,
            )
            .join("; ")}`,
        });
      }
      return attempt(() => run(parsed.data));
    },
  };
}

const empty = z.object({});

/**
 * The tools a Bot with a computer is offered.
 *
 * Built per run and per person rather than once at boot, because the actor is what the audit row
 * names and the Bot is which computer gets driven. A module-level list would have to take both on
 * every call, which is the same thing written less safely.
 */
export function computerTools(context: ComputerToolsContext): GrantedTool[] {
  const { gateway, botId, actor } = context;

  return [
    tool(
      "computer_navigate",
      "Open a web page on your own computer so the person can watch. Use this when asked to look " +
        "at, visit, open or check a website. Returns the page title and its readable text, so answer " +
        "from what comes back rather than telling the person to go and look.",
      z.object({
        url: z
          .string()
          .describe("Full web address to open, including https://"),
      }),
      (args) => gateway.navigate(botId, actor, args.url),
    ),

    tool(
      "computer_read",
      "Read the page currently open on your computer, without opening anything. Use this after you " +
        "click something that changes the page, such as submitting a form, to find out what it now says.",
      empty,
      () => gateway.read(botId),
    ),

    tool(
      "computer_snapshot",
      "List the things on the current page you can act on: fields, buttons, links and checkboxes, " +
        "each with a ref, its label and its current value. Call this BEFORE clicking or typing, and " +
        "use the refs it returns. Always send back the snapshotId it gives you. If an action reports " +
        "that your refs are stale, the page changed: call this again and use the new refs.",
      empty,
      () => gateway.snapshot(botId),
    ),

    tool(
      "computer_type",
      "Enter text into a field on the page. Give the ref of the field from your most recent " +
        "snapshot and the snapshotId it came from. This replaces whatever the field already contains. " +
        "Set submit to true to press Enter afterwards.",
      z.object({
        ref: z
          .string()
          .describe("Ref of the field, from your most recent snapshot"),
        snapshotId: z.number().describe("The snapshotId that ref came from"),
        text: z.string().describe("The text to enter"),
        submit: z
          .boolean()
          .optional()
          .describe("Press Enter after typing, to submit a single-field form"),
      }),
      (args) =>
        gateway.type(botId, actor, {
          ref: args.ref,
          snapshotId: args.snapshotId,
          text: args.text,
          ...(args.submit === undefined ? {} : { submit: args.submit }),
        }),
    ),

    tool(
      "computer_click",
      "Click something on the page: a button, a link, a checkbox or a radio option. Give the ref " +
        "from your most recent snapshot and the snapshotId it came from.",
      z.object({
        ref: z
          .string()
          .describe(
            "Ref of the element to click, from your most recent snapshot",
          ),
        snapshotId: z.number().describe("The snapshotId that ref came from"),
      }),
      (args) =>
        gateway.click(botId, actor, {
          ref: args.ref,
          snapshotId: args.snapshotId,
        }),
    ),

    tool(
      "computer_key",
      "Press a key, such as Enter, Tab or Escape. Give a ref to press it while a particular field " +
        "is focused, or omit the ref to press it on the page.",
      z.object({
        key: z.string().describe("Key name, such as Enter, Tab or Escape"),
        ref: z.string().optional().describe("Optional ref to press the key on"),
        snapshotId: z
          .number()
          .optional()
          .describe(
            "The snapshotId the ref came from, required if ref is given",
          ),
      }),
      (args) =>
        gateway.key(botId, actor, {
          key: args.key,
          ...(args.ref === undefined ? {} : { ref: args.ref }),
          ...(args.snapshotId === undefined
            ? {}
            : { snapshotId: args.snapshotId }),
        }),
    ),

    tool(
      "computer_scroll",
      "Scroll the page down, or up with a negative amount, to bring more of a long page into view.",
      z.object({
        deltaY: z
          .number()
          .optional()
          .describe("Pixels to scroll; positive is down. Defaults to 600."),
      }),
      (args) =>
        gateway.scroll(
          botId,
          actor,
          args.deltaY === undefined ? {} : { deltaY: args.deltaY },
        ),
    ),

    tool(
      "computer_list_files",
      "List what is in your workspace: every file and folder you have saved, with sizes. Call this " +
        "FIRST when you are asked what files you have, or before reading a file whose exact name you " +
        "are not sure of. Never guess a filename.",
      z.object({
        path: z
          .string()
          .optional()
          .describe("Optional folder to list. Omit for the whole workspace."),
      }),
      (args) =>
        gateway.listFiles(
          botId,
          actor,
          args.path === undefined ? {} : { path: args.path },
        ),
    ),

    tool(
      "computer_read_file",
      "Read a file you saved earlier in your own workspace. Paths are relative to your workspace, " +
        "such as notes.md or reports/august.csv. Your workspace survives between conversations, so use " +
        "this to pick up notes you made before.",
      z.object({
        path: z
          .string()
          .describe("Path relative to your workspace, such as notes.md"),
      }),
      (args) => gateway.readFile(botId, actor, { path: args.path }),
    ),

    tool(
      "computer_write_file",
      "Save a file in your own workspace so you still have it later. Paths are relative to your " +
        "workspace and folders are created as needed. Set append to true to add to the end of an " +
        "existing file rather than replacing it. Text only.",
      z.object({
        path: z
          .string()
          .describe(
            "Path relative to your workspace, such as reports/august.csv",
          ),
        contents: z.string().describe("The text to save"),
        append: z
          .boolean()
          .optional()
          .describe("Add to the end of the file instead of replacing it"),
      }),
      (args) =>
        gateway.writeFile(botId, actor, {
          path: args.path,
          contents: args.contents,
          ...(args.append === undefined ? {} : { append: args.append }),
        }),
    ),

    tool(
      "computer_run_command",
      "Run a shell command on your own computer. Use this for anything the browser cannot do: " +
        "installing a tool you need, processing a file you saved, running a script. The working " +
        "directory is your workspace, so paths are relative to it and files you write here are the " +
        "same ones the file tools see. Commands run in bash, so pipes and && work. Long output is " +
        "truncated from the start, and a command that runs too long is stopped. " +
        "You are not the root user, so anything that writes outside your workspace needs sudo, " +
        "which asks for no password: installing a package is " +
        "`sudo apt-get update && sudo apt-get install -y <package>`. If sudo is refused, this " +
        "computer does not grant it, so say so rather than retrying.",
      z.object({
        command: z
          .string()
          .describe("The command to run, such as: sudo apt-get install -y jq"),
      }),
      (args) => gateway.runCommand(botId, actor, { command: args.command }),
    ),

    /*
     * Not a computer call at all, and here because it belongs to the same run.
     *
     * A Bot that declines something has made a decision an administrator wants to see, and the only
     * place that decision exists is the model's own sentence. Recording nothing when no recorder is
     * configured, rather than withholding the tool: a Bot should always be able to say it said no.
     */
    tool(
      "report_refusal",
      "Record that you DECLINED something you were asked to do, because it looked unsafe, was outside " +
        "what you are for, or you judged you should not. Call this whenever you say no to a request, in " +
        "addition to telling the person. It changes nothing about your answer; it exists so an " +
        "administrator can see what this Bot is being asked to do. Do not call it when you simply could " +
        "not do something, only when you chose not to.",
      z.object({
        reason: z
          .string()
          .describe("Why you declined, in one sentence and in your own words"),
        request: z
          .string()
          .optional()
          .describe("What you were asked to do, in a few words"),
      }),
      async (args) => {
        await context.recordRefusal?.({
          botId,
          actor,
          reason: args.reason,
          ...(args.request === undefined ? {} : { request: args.request }),
        });
        return { recorded: true };
      },
    ),
  ];
}
