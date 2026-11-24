import {
  PERSON_COMPUTER_TOOL,
  type PersonComputerAnswer,
  type PersonComputerScreen,
  screenOfAnswer,
} from "@openbot/shared/person-computer";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { agentQueryOptions } from "@/lib/agents/queries";
import { desktopShell } from "@/lib/desktop/shell";
import { botOfAgent, type ToolCallContext } from "./active-bot";
import { useFrontendTool } from "./approval-tools";

/**
 * A Bot using the person's own computer: the screen, the mouse and the keyboard of the Mac that
 * OpenBot Desktop runs on. A prototype.
 *
 * A tool of this page, never of the server. Desktop takes each action (`person_computer` in its
 * page plugin), and the first action of a session asks the person in Desktop's own dialog.
 * So it is offered only in OpenBot Desktop's window on a Mac, and only while the conversation's run
 * is handled here. Every answer carries the screen after the action, which the backend puts in
 * front of the model as a picture.
 *
 * The input follows the shape models already use for a computer: an `action`, and a `coordinate`
 * in the latest screenshot's pixels. Any model that calls tools and reads images can use it.
 */

const ACTIONS = [
  "screenshot",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "mouse_move",
  "left_click_drag",
  "type",
  "key",
  "scroll",
  "wait",
] as const;

const point = z.array(z.number()).length(2);

const parameters = z.object({
  action: z
    .enum(ACTIONS)
    .describe(
      "What to do. screenshot only looks; every other action also answers with a screenshot after it.",
    ),
  coordinate: point
    .optional()
    .describe(
      "[x, y] in pixels of the latest screenshot, from its top left corner. Needed for the clicks, mouse_move and scroll, and where a left_click_drag ends.",
    ),
  start_coordinate: point
    .optional()
    .describe("[x, y] where a left_click_drag starts."),
  text: z
    .string()
    .optional()
    .describe(
      "For type: the text to type. For key: the keys to press, such as Return, cmd+c or cmd+shift+t, several separated by spaces.",
    ),
  scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
  scroll_amount: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .describe(
      "For scroll: how far, in steps of about 100 pixels. 3 when left out.",
    ),
  duration: z
    .number()
    .min(0)
    .max(10)
    .optional()
    .describe("For wait: the seconds to wait before looking again."),
});

type Input = z.infer<typeof parameters>;

const DESCRIPTION =
  "Use the person's own computer, their Mac: see its screen and use its mouse and keyboard as they would. " +
  "Use it only when the person asks you to do something on their computer, such as using an app there. " +
  "For files and folders (finding, reading, renaming or moving them), use the folder tools when you are offered them: host_list_folders, host_list_files, host_read_file, host_write_file and host_run_command are much faster and surer than the screen. Use this tool for files only when the person hasn't shared the folder. " +
  "Every action takes a few seconds, so use the keyboard where you can: in Finder, Return renames the selected item. " +
  "Every action answers with a screenshot of the screen after it. Coordinates are pixels of the latest screenshot, from its top left corner. " +
  "Start with the screenshot action. Use the keyboard where you can: cmd+space opens Spotlight, and typing a file's or an app's name there and pressing Return opens it. " +
  "The person is asked once, the first time a Bot uses their computer while OpenBot is open. If they don't allow it, don't try again unless they ask. " +
  "Never type a password: ask the person to type it themselves.";

/** The action Desktop takes for the model's input, or what the input is missing. */
export function desktopAction(
  input: Input,
): { action: Record<string, unknown> } | { missing: string } {
  const at = input.coordinate;
  const withPoint = (kind: string, extra: Record<string, unknown> = {}) =>
    at
      ? { action: { kind, x: at[0], y: at[1], ...extra } }
      : { missing: `${input.action} needs coordinate [x, y].` };
  switch (input.action) {
    case "screenshot":
      return { action: { kind: "screenshot" } };
    case "left_click":
      return withPoint("click", { button: "left", count: 1 });
    case "right_click":
      return withPoint("click", { button: "right", count: 1 });
    case "middle_click":
      return withPoint("click", { button: "middle", count: 1 });
    case "double_click":
      return withPoint("click", { button: "left", count: 2 });
    case "triple_click":
      return withPoint("click", { button: "left", count: 3 });
    case "mouse_move":
      return withPoint("move");
    case "left_click_drag":
      return input.start_coordinate && at
        ? { action: { kind: "drag", from: input.start_coordinate, to: at } }
        : { missing: "left_click_drag needs start_coordinate and coordinate." };
    case "type":
      return input.text
        ? { action: { kind: "type", text: input.text } }
        : { missing: "type needs text." };
    case "key":
      return input.text?.trim()
        ? { action: { kind: "key", keys: input.text } }
        : { missing: "key needs text, such as Return or cmd+c." };
    case "scroll":
      return withPoint("scroll", {
        direction: input.scroll_direction ?? "down",
        amount: input.scroll_amount ?? 3,
      });
    case "wait":
      return { action: { kind: "wait", seconds: input.duration ?? 1 } };
  }
}

/** What the model reads as done, beside the screenshot. */
function didFor(input: Input): string {
  const at = input.coordinate ? ` at (${input.coordinate.join(", ")})` : "";
  switch (input.action) {
    case "screenshot":
      return "Took a screenshot.";
    case "type":
      return "Typed the text.";
    case "key":
      return `Pressed ${input.text}.`;
    case "wait":
      return `Waited ${input.duration ?? 1} seconds.`;
    case "scroll":
      return `Scrolled ${input.scroll_direction ?? "down"}${at}.`;
    default:
      return `Did ${input.action}${at}.`;
  }
}

/** The line in the conversation: what was done, and what was tried when it didn't happen. */
const LINES: Record<(typeof ACTIONS)[number], { done: string; tried: string }> =
  {
    screenshot: { done: "Looked at your screen", tried: "Look at your screen" },
    left_click: {
      done: "Clicked on your computer",
      tried: "Click on your computer",
    },
    right_click: {
      done: "Right-clicked on your computer",
      tried: "Right-click on your computer",
    },
    middle_click: {
      done: "Clicked on your computer",
      tried: "Click on your computer",
    },
    double_click: {
      done: "Double-clicked on your computer",
      tried: "Double-click on your computer",
    },
    triple_click: {
      done: "Triple-clicked on your computer",
      tried: "Triple-click on your computer",
    },
    mouse_move: { done: "Moved your mouse", tried: "Move your mouse" },
    left_click_drag: {
      done: "Dragged on your computer",
      tried: "Drag on your computer",
    },
    type: { done: "Typed on your computer", tried: "Type on your computer" },
    key: {
      done: "Pressed keys on your computer",
      tried: "Press keys on your computer",
    },
    scroll: {
      done: "Scrolled on your computer",
      tried: "Scroll on your computer",
    },
    wait: { done: "Waited", tried: "Wait" },
  };

function detailFor(args: Partial<Input> | undefined): string | undefined {
  if (!args) return undefined;
  if (args.action === "type" && args.text) return args.text.slice(0, 120);
  if (args.action === "key" && args.text) return args.text;
  if (args.action === "scroll") return args.scroll_direction ?? "down";
  return undefined;
}

/** The answer in a call's result, whichever way the SDK hands it back. */
function answerOf(
  result: unknown,
):
  | { ok: true; screen: PersonComputerScreen }
  | { ok: false; reason: string }
  | undefined {
  const text =
    typeof result === "string" ? result : result ? JSON.stringify(result) : "";
  if (!text) return undefined;
  const withScreen = screenOfAnswer(text);
  if (withScreen) return { ok: true, screen: withScreen.screen };
  try {
    const answer = JSON.parse(text) as { ok?: unknown; reason?: unknown };
    if (answer.ok === false && typeof answer.reason === "string")
      return { ok: false, reason: answer.reason };
  } catch {
    // Not an answer of this tool's.
  }
  return undefined;
}

/** Inside OpenBot Desktop's window on a Mac, the only place this tool can act. */
function onDesktopMac(): boolean {
  return (
    desktopShell() !== null &&
    typeof navigator !== "undefined" &&
    /Mac/.test(navigator.userAgent)
  );
}

export function PersonComputerTool() {
  const queryClient = useQueryClient();
  useFrontendTool({
    name: PERSON_COMPUTER_TOOL,
    description: DESCRIPTION,
    parameters,
    available: onDesktopMac(),
    handler: async (
      input: Input,
      { agent, signal }: ToolCallContext = {},
    ): Promise<PersonComputerAnswer> => {
      const shell = desktopShell();
      if (!shell)
        return {
          ok: false,
          reason:
            "Using the person's computer works only in OpenBot Desktop on a Mac.",
        };
      const conversation = agent?.threadId;
      if (!conversation)
        return {
          ok: false,
          reason: "Using the person's computer works only in a conversation.",
        };
      if (signal?.aborted)
        return { ok: false, reason: "The person stopped this." };
      const asked = desktopAction(input);
      if ("missing" in asked) return { ok: false, reason: asked.missing };
      const botId = botOfAgent(agent);
      // The name the person knows the Bot by, for Desktop's question. Desktop says "This Bot" without it.
      const bot = botId
        ? await queryClient.fetchQuery(agentQueryOptions(botId)).then(
            (profile) => profile.name ?? "",
            () => "",
          )
        : "";
      try {
        const screen = (await shell.invoke(
          "plugin:openbot-desktop|person_computer",
          {
            action: asked.action,
            conversation: { id: conversation, bot },
          },
        )) as PersonComputerScreen;
        return { ok: true, did: didFor(input), screen };
      } catch (error) {
        return {
          ok: false,
          reason:
            typeof error === "string"
              ? error
              : error instanceof Error
                ? error.message
                : "Couldn't use the person's computer.",
        };
      }
    },
    render: ({ args, result, status }) => {
      const input = args as Partial<Input> | undefined;
      const line = LINES[input?.action ?? "screenshot"] ?? LINES.screenshot;
      const answer = answerOf(result);
      const failed = answer?.ok === false;
      return (
        <ToolLine
          label={line.done}
          attempted={line.tried}
          failedLabel={`Couldn't ${line.tried.charAt(0).toLowerCase()}${line.tried.slice(1)}`}
          detail={failed ? answer.reason : detailFor(input)}
          running={status !== "complete"}
          failed={failed}
        >
          {answer?.ok ? (
            <img
              src={`data:${answer.screen.mimeType};base64,${answer.screen.base64}`}
              alt="Your screen after this step"
              width={answer.screen.width}
              height={answer.screen.height}
              className="h-auto w-full rounded-md border"
            />
          ) : undefined}
        </ToolLine>
      );
    },
  });
  return null;
}
