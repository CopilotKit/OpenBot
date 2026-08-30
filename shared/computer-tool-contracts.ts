import { z } from "zod";

/**
 * Platform-neutral computer tool contracts shared by the web and Channels surfaces.
 *
 * Keep handlers and renderers at their platform boundary. A contract contains only the public tool
 * name, description, and Zod parameters so every surface gives the model the same call shape.
 */

export const computerNavigateContract = {
  name: "computer_navigate",
  description:
    "Open a web page on your own computer so the person can watch. Use this when asked to look " +
    "at, visit, open or check a website. Returns the page title and its readable text, so answer " +
    "from what comes back rather than telling the person to go and look.",
  parameters: z.object({
    url: z.string().describe("Full web address to open, including https://"),
  }),
} as const;

/** Channels-only bounded path for a website summary plus visual proof. */
export const computerOpenAndShareScreenshotContract = {
  name: "computer_open_and_share_screenshot",
  description:
    "Open a website, return its readable text for summarization, and share a current PNG " +
    "screenshot in this Slack conversation in one operation. Use this instead of separate " +
    "navigate and screenshot calls whenever the request asks both to inspect or summarize a site " +
    "and to send a picture.",
  parameters: z.object({
    url: z.string().describe("Full web address to open, including https://"),
    filename: z
      .string()
      .optional()
      .describe("Optional PNG filename to show in Slack"),
  }),
} as const;

export const computerReadContract = {
  name: "computer_read",
  description:
    "Read the page currently open on your computer, without opening anything. Use this after you " +
    "click something that changes the page, such as submitting a form, to find out what it now says.",
  parameters: z.object({}),
} as const;

export const computerSnapshotContract = {
  name: "computer_snapshot",
  description:
    "List the things on the current page you can act on: fields, buttons, links and checkboxes, " +
    "each with a ref, its label and its current value. Call this BEFORE clicking or typing, and " +
    "use the refs it returns. Always send back the snapshotId it gives you. If an action reports " +
    "that your refs are stale, the page changed: call this again and use the new refs.",
  parameters: z.object({}),
} as const;

export const computerTypeContract = {
  name: "computer_type",
  description:
    "Enter text into a field on the page. Give the ref of the field from your most recent " +
    "snapshot and the snapshotId it came from. This replaces whatever the field already contains. " +
    "Set submit to true to press Enter afterwards.",
  parameters: z.object({
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
} as const;

export const computerClickContract = {
  name: "computer_click",
  description:
    "Click something on the page: a button, a link, a checkbox or a radio option. Give the ref " +
    "from your most recent snapshot and the snapshotId it came from.",
  parameters: z.object({
    ref: z
      .string()
      .describe("Ref of the element to click, from your most recent snapshot"),
    snapshotId: z.number().describe("The snapshotId that ref came from"),
  }),
} as const;

export const computerKeyContract = {
  name: "computer_key",
  description:
    "Press a key, such as Enter, Tab or Escape. Give a ref to press it while a particular field " +
    "is focused, or omit the ref to press it on the page.",
  parameters: z.object({
    key: z.string().describe("Key name, such as Enter, Tab or Escape"),
    ref: z.string().optional().describe("Optional ref to press the key on"),
    snapshotId: z
      .number()
      .optional()
      .describe("The snapshotId the ref came from, required if ref is given"),
  }),
} as const;

export const computerRequestSecretContract = {
  name: "computer_request_secret",
  description:
    "Ask the person for ONE value you must not be told: a password, a one-time code, a card number. " +
    "Focus the field first with computer_click, then call this with the ref of that field and a " +
    "short label for what you need. They type it into a masked box that goes straight to the page. " +
    "You will never see the value, and you must not ask for it any other way. Prefer this over a " +
    "full takeover when you only need one field filled in. The value is only TYPED into the field: " +
    "if the form needs submitting, do that yourself afterwards with computer_click.",
  parameters: z.object({
    label: z
      .string()
      .describe(
        "What you need, in a few words, e.g. 'the code sent to your phone'",
      ),
    ref: z
      .string()
      .describe("Ref of the field it goes in, from your most recent snapshot"),
    snapshotId: z.number().describe("The snapshotId that ref came from"),
  }),
} as const;

export const reportRefusalContract = {
  name: "report_refusal",
  description:
    "Record that you DECLINED something you were asked to do, because it looked unsafe, was outside " +
    "what you are for, or you judged you should not. Call this whenever you say no to a request, in " +
    "addition to telling the person. It changes nothing about your answer; it exists so an " +
    "administrator can see what this Bot is being asked to do. Do not call it when you simply could " +
    "not do something, only when you chose not to.",
  parameters: z.object({
    reason: z
      .string()
      .describe("Why you declined, in one sentence and in your own words"),
    request: z
      .string()
      .optional()
      .describe("What you were asked to do, in a few words"),
  }),
} as const;

export const computerRequestHelpContract = {
  name: "computer_request_help",
  description:
    "Ask the person to take control of your computer and do something you cannot: sign in, enter a " +
    "password or a one-time code, or clear a CAPTCHA. Say specifically what you need done. They " +
    "will drive the browser themselves and hand it back, and you carry on in the same session. " +
    "Use this INSTEAD of giving up, and instead of ever asking them to type a password to you. " +
    "This call is the only thing that reaches them: until you make it they are not looking at the " +
    "page and have no way to help, so saying you need them to sign in, or asking whether they would " +
    "like to proceed, hands over nothing and leaves the page where it is.",
  parameters: z.object({
    reason: z
      .string()
      .describe(
        "What you need the person to do, in one sentence, e.g. 'This page is asking for a code sent to your phone.'",
      ),
  }),
} as const;

export const computerListFilesContract = {
  name: "computer_list_files",
  description:
    "List what is in your workspace: every file and folder you have saved, with sizes. Call this " +
    "FIRST when you are asked what files you have, or before reading a file whose exact name you " +
    "are not sure of. Never guess a filename.",
  parameters: z.object({
    path: z
      .string()
      .optional()
      .describe("Optional folder to list. Omit for the whole workspace."),
  }),
} as const;

export const computerReadFileContract = {
  name: "computer_read_file",
  description:
    "Read a file you saved earlier in your own workspace. Paths are relative to your workspace, " +
    "such as notes.md or reports/august.csv. Your workspace survives between conversations, so use " +
    "this to pick up notes you made before.",
  parameters: z.object({
    path: z
      .string()
      .describe("Path relative to your workspace, such as notes.md"),
  }),
} as const;

export const computerRunCommandContract = {
  name: "computer_run_command",
  description:
    "Run a shell command on your own computer. Use this for anything the browser cannot do: " +
    "installing a tool you need, processing a file you saved, running a script. The working " +
    "directory is your workspace, so paths are relative to it and files you write here are the " +
    "same ones the file tools see. Commands run in bash, so pipes and && work. Long output is " +
    "truncated from the start, and a command that runs too long is stopped. " +
    "You are not the root user, so anything that writes outside your workspace needs sudo, " +
    "which asks for no password: installing a package is " +
    "`sudo apt-get update && sudo apt-get install -y <package>`. If sudo is refused, this " +
    "computer does not grant it, so say so rather than retrying.",
  parameters: z.object({
    command: z
      .string()
      .describe("The command to run, such as: sudo apt-get install -y jq"),
  }),
} as const;

export const computerWriteFileContract = {
  name: "computer_write_file",
  description:
    "Save a file in your own workspace so you still have it later. Paths are relative to your " +
    "workspace and folders are created as needed. Set append to true to add to the end of an " +
    "existing file rather than replacing it. Text only.",
  parameters: z.object({
    path: z
      .string()
      .describe("Path relative to your workspace, such as reports/august.csv"),
    contents: z.string().describe("The text to save"),
    append: z
      .boolean()
      .optional()
      .describe("Add to the end of the file instead of replacing it"),
  }),
} as const;

export const computerScrollContract = {
  name: "computer_scroll",
  description:
    "Scroll the page down, or up with a negative amount, to bring more of a long page into view.",
  parameters: z.object({
    deltaY: z
      .number()
      .optional()
      .describe("Pixels to scroll; positive is down. Defaults to 600."),
  }),
} as const;

/** Channels-only capture and delivery of the current browser viewport. */
export const computerScreenshotContract = {
  name: "computer_screenshot",
  description:
    "Capture the web page currently open on your computer and share the PNG in this Slack " +
    "conversation. Use this after navigating when someone asks for a picture or screenshot of a " +
    "website. Optionally provide the filename people should see.",
  parameters: z.object({
    filename: z
      .string()
      .optional()
      .describe("Optional PNG filename to show in Slack"),
  }),
} as const;

/** Channels-only delivery of an existing complete workspace text file. */
export const computerShareFileContract = {
  name: "computer_share_file",
  description:
    "Share a complete text file from your workspace in this Slack conversation. Use the saved " +
    "workspace path; optionally provide the filename people should see.",
  parameters: z.object({
    path: z
      .string()
      .describe("Path relative to your workspace, such as reports/august.csv"),
    filename: z
      .string()
      .optional()
      .describe("Optional filename to show in Slack"),
  }),
} as const;
