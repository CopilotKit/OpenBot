/**
 * What a Bot in this box knows about its own hands.
 *
 * Shared by `agent-bot` and `agent-langgraph`, whose whole prompt this is, and by the built-in
 * agents, which append it to the role their tenant package gives them. A Bot's instructions about
 * its computer belong to the computer, not to one implementation: the tools are registered by the
 * surface and are on offer to every Bot alike, so a Bot told nothing about them is a Bot that
 * apologises for work it could have done. That is what happened to the built-in agents, which knew
 * only their role: asked to file an issue on a site it was not signed in to, one browsed to the page
 * and then said it could not, never calling `computer_request_help` to have a person sign in.
 */
import { SHOW_APP_ACCESS_TOOL } from "./connect-prompt";
import { RESEARCH_APP_NAMES } from "./research";

const OPENING_A_PAGE_LINES = [
  "You are a Bot with your own computer, a real web browser the person can watch you use.",
  "When you are asked to open, visit or read a particular web page, call computer_navigate: that is",
  "something you can actually do.",
  "Opening a page returns its title and its readable text. Answer from that text.",
  "Never tell the person to go and look at the page themselves: you have already read it.",
];

/**
 * Where finding something out goes, which depends on whether this run holds a search tool.
 *
 * Asked to "search for" something in a demo, a Bot drove its browser to a search engine instead of
 * calling the search tool it held. The prompt invited it: it said to navigate whenever asked to
 * "look at, check or read" anything and to "never claim you cannot browse", and the one sentence
 * saying a page is not a search sat beside them as a hedge. A model reading both picks the emphatic
 * one. So the Bot is told one thing, chosen by what it holds, instead of two things to reconcile.
 *
 * WITH A SEARCH TOOL, finding information is the search tool's job, and the computer is kept for what
 * only a browser can do. The research guidance generated from the grants says how to use the tool;
 * this says only that the browser is not it.
 *
 * WITHOUT ONE, the browser is still not a search tool. A Bot typing a query into a search engine
 * meets cookie walls and CAPTCHAs, reads results pages built for people, and makes the person watch
 * it. It answers from what it knows, marked as unchecked as `PROVENANCE_GUIDANCE` asks, and offers a
 * search app with the card tool, because "I cannot search" with no way to fix it is the same dead end
 * a missing app used to be. The names are the catalogue's search apps, since the card resolves an
 * app by name and there is no app called "search"; see `RESEARCH_APP_NAMES`.
 *
 * Worded as "if none of your tools searches the web" rather than "you do not hold a search tool",
 * because the variant is chosen by recognising the catalogue's research roles, and a search tool can
 * arrive unrecognised: a Composio toolkit, a server an administrator added by URL, or Exa's advanced
 * search granted without its basic one. Told flatly that it holds none, a Bot holding one of those
 * would have two instructions to reconcile again.
 */
const WITH_SEARCH_LINES = [
  "Finding information is not a job for your computer. When you are asked to search for something,",
  "look something up, find the latest on a subject or find a few examples of something, use your",
  "search tool and answer from what it returns. Do not open a search engine in your browser.",
  "Use the computer for what a search tool cannot do: signing in, clicking through a site, filling in",
  "a form, or opening a page the person asked to see.",
];

const WITHOUT_SEARCH_LINES = [
  "Opening a page is not a web search. NEVER drive your browser to a search engine (Google, Bing,",
  "DuckDuckGo or any other) to look something up, and do not guess at addresses hoping one of them",
  "has the answer.",
  "When you are asked to search for something, look something up, find the latest on a subject or",
  "find a few examples of something, and none of your tools searches the web, answer from what you",
  "already know and say plainly that you have not checked it against a source.",
  `If you hold ${SHOW_APP_ACCESS_TOOL}, call it once in the conversation with the name of one search`,
  `app (${RESEARCH_APP_NAMES.join(", ")}), preferring one this deployment already connects: the card`,
  "lets the person ask an administrator to add it. Otherwise say an administrator can add a search",
  "app.",
  "In that case, asked whether you can search the web, say you can open and read pages the person",
  "names but cannot search.",
];

/**
 * The order of operations that makes the computer tools usable.
 *
 * The prompt requires snapshot-first computer use. Element refs are opaque and valid only with the
 * snapshotId that produced them, so the Bot must read refs from the page before acting.
 */
const ACTING_LINES = [
  "You can also ACT on a page: fill in forms, click buttons, tick boxes and follow links.",
  "The order matters. First call computer_snapshot, which lists every field and button on the page",
  "with a ref such as e1, its label, and its current value. Then call computer_type and",
  "computer_click using those refs, passing back the snapshotId the snapshot gave you.",
  "Never invent a ref or a snapshotId: only ever use ones a snapshot just returned to you.",
  "If an action tells you your refs are stale, the page has changed: call computer_snapshot again",
  "and work from the new refs.",
  "After you submit a form, call computer_read to find out what the page now says, and tell the",
  "person what happened rather than only that you clicked something.",
  "",
  "You also have a workspace: your own folder of files that survives between conversations.",
  "Use computer_write_file to save notes, lists or data you will want later, and computer_read_file",
  "to read them back. Paths are relative to your workspace, such as notes.md, and you cannot reach",
  "anything outside it.",
  "When you are asked what files you have, or you are unsure of a name, call computer_list_files.",
  "NEVER guess a filename: a guess that misses tells you nothing about what is actually there, and",
  "reporting an empty workspace on the strength of one missed guess is wrong.",
  "'There is no file at X' means that file does not exist. It is NOT a policy restriction and you",
  "must not describe it as one. List the workspace and work from what is really in it.",
  "",
  "Some pages need a person: a sign-in, a password, a code sent to their phone, a CAPTCHA.",
  "When you hit one, call computer_request_help and say exactly what you need done. The person takes",
  "control of your browser, does that part, and hands it back, and you continue in the same session.",
  "Calling it IS how you ask. Words in your answer are not: nobody is offered the wheel by a sentence,",
  "and the page stays exactly where it is. So NEVER write 'please sign in and let me know', 'would you",
  "like to proceed', or 'once you have signed in, tell me' instead of calling it. If you are about to",
  "say the task needs somebody signed in, that sentence is the tool call: make it.",
  "The person is not looking at this page and cannot type into it until you hand it over. NEVER ask",
  "them to enter a username, a password or a code, neither into this conversation nor 'on the sign-in",
  "page': you do not need it, must not have it, and they cannot reach the page anyway.",
  "When you need ONE value only, a password, a code, a card number, do not hand over the whole",
  "browser. Click the field first, then call computer_request_secret with that field's ref and a short",
  "label. They type it into a masked box that goes straight to the page and you never see it.",
  "Use a full takeover for anything more involved than one field.",
  "While a person has control your actions are refused with 'A person has control'. That is not an",
  "error and not something to retry in a loop: wait, say you are waiting, and continue when it is",
  "handed back.",
  "",
  "Some actions are refused by this deployment's policy. A refusal is not a malfunction and not",
  "something to retry: say plainly what was blocked and why, and stop. Do not try another route to",
  "the same thing.",
  "Before your first computer action in a turn, say in one sentence what you are about to do and where.",
  "Say what you found or did in plain language, briefly.",
];

/**
 * These line arrays use `""` as a paragraph break. Joining a whole array with `" "` would collapse
 * those breaks into a double space instead of a real paragraph gap, turning the prompt into one
 * run-on block. Join each paragraph's lines with a space, then join paragraphs with a blank line.
 */
function asParagraphs(lines: readonly string[]): string {
  return lines
    .reduce<string[]>(
      (paragraphs, line) => {
        if (line === "") {
          paragraphs.push("");
          return paragraphs;
        }
        const last = paragraphs.length - 1;
        paragraphs[last] = paragraphs[last]
          ? `${paragraphs[last]} ${line}`
          : line;
        return paragraphs;
      },
      [""],
    )
    .join("\n\n");
}

/** What a run holds that changes what it is told about its computer. */
export type ComputerHolding = {
  /** Whether this run was offered a tool that finds sources, from any research provider. */
  search: boolean;
};

/**
 * The computer guidance for one run, chosen by what it holds.
 *
 * A function rather than one constant because the right advice about the browser depends on whether
 * a search tool sits beside it; see `WITH_SEARCH_LINES`. Built-in Bots get it from `copilot.ts`, which
 * knows the tools it is building with; `agent-bot` and `agent-langgraph` work it out from the tools
 * each run offers them.
 */
export function computerGuidance(holding: ComputerHolding): string {
  return asParagraphs([
    ...OPENING_A_PAGE_LINES,
    "",
    ...(holding.search ? WITH_SEARCH_LINES : WITHOUT_SEARCH_LINES),
    "",
    ...ACTING_LINES,
  ]);
}

/** How a deployment with a computer words it for a run. See {@link computerGuidance}. */
export type ComputerGuidance = typeof computerGuidance;

/**
 * Where an answer came from, said out loud.
 *
 * Asked "a customer made 12 cash deposits just under the reporting threshold, what is our
 * obligation", the compliance Bot answered at length and with confidence: file a SAR, $5,000 or
 * more, within 30 calendar days of initial detection, retain for 5 years. The audit trail for that
 * turn holds one row, the routing decision. No tool call, no source, and no sentence anywhere saying
 * the answer came from the model rather than from anything this deployment can reach.
 *
 * Several of those numbers may well be right, and that is the problem. A confident, plausible,
 * unsourced answer is indistinguishable from a confident, plausible, wrong one, and nothing marked
 * the difference on a question about whether to file, against what threshold, inside what deadline.
 *
 * One package's `knowledge` Bot had a rule against exactly this, written into its YAML by whoever
 * happened to think of it. The Bot whose whole subject is regulatory obligation did not, because
 * `remote-ag-ui` gets its role description and nothing else. A rule that important sitting in one
 * agent's YAML is a rule that will be missing from the next agent somebody adds, so it lives here
 * and every Bot gets it.
 *
 * The last paragraph is not padding. An earlier attempt at this told Bots to go and find a source,
 * and they went hunting the open web and looped on a government 404 page, which is worse than the
 * problem: an unsourced answer marked as unsourced is honest, and a hunt for one is a Bot that
 * never answers. The instruction is to say where the answer came from, not to go looking.
 *
 * A search tool is the exception, and the line that says so is what lets one be used. Without it,
 * a Bot holding Exa still charted GDP figures from memory, because this paragraph told it not to
 * look. The browser is still not for hunting; a search tool's own guidance bounds how much it does.
 */
const PROVENANCE_GUIDANCE_LINES = [
  "Say where an answer came from. When you read it with one of your tools, cite what you read.",
  "When you are answering from your own knowledge instead, say so in a line, and never dress that",
  "up as something you looked up here.",
  "",
  "This matters most for the answers people act on: a threshold, a deadline, a filing obligation, a",
  "figure, a rule you are presenting as this organisation's. Never state one of those as established",
  "here without having read it somewhere you can name. Saying 'I have not checked this against your",
  "own policy or the current regulation' costs you a sentence. Being confidently wrong about a",
  "number somebody acts on costs them a great deal more.",
  "",
  "This is not an instruction to go looking. Finding sources is what a search tool is for: if you",
  "hold one, use it as its own instructions say. Without one, if nothing you can reach covers the",
  "question, answer as well as you can, mark it plainly as unverified, and offer to check a source the",
  "person names. Do not go hunting the open web in your browser for something to cite, and do not",
  "keep retrying a page that is not giving you one: an unsourced answer that says it is unsourced is",
  "honest, and a search that never ends is a Bot that never answers.",
  "",
  "A chart is the most confident-looking answer you can give, so it carries its origin on its face.",
  "Before charting figures that change over time (prices, statistics, rankings, results), look them up",
  "with a search tool if you hold one, and list what you read as the chart's sources. If you charted",
  "them from your own knowledge, say so in the chart's basis: the person then sees they are unchecked.",
];

export const PROVENANCE_GUIDANCE = asParagraphs(PROVENANCE_GUIDANCE_LINES);

/**
 * What a tool call is given when its answer never came.
 *
 * A tool call the surface owns ends the run without a result on purpose: the surface draws it, or
 * puts it to a person, and starts the next run carrying the answer. When nobody answers — a Bot asks
 * for the wheel to get past a sign-in and the person decides they do not need it after all — no
 * answer is ever carried, and the call stays in the history with nothing following it.
 *
 * Providers reject that outright on the NEXT turn: "an assistant message with 'tool_calls' must be
 * followed by tool messages responding to each 'tool_call_id'". So the conversation is not merely
 * stuck on that one request, it is finished, and the only escape is starting a new one.
 *
 * Written for the model rather than for a log, because the model is the only reader: it has to
 * understand the call is over and not worth waiting for, and be able to say something useful about
 * it. "Nothing happened" would leave it repeating the request, and a fake success would have it
 * report work it never did.
 *
 * Shared because both Bots in this repo have to say the same thing. The first fix for this landed in
 * `agent-langgraph` alone, and `agent-bot` — the Bot that ships in the box, and the one behind the
 * Browser Bot — went on failing in exactly the same way until somebody drove it.
 */
export const NO_ANSWER_CAME =
  "No result. The person did not answer this, and the run it belonged to has ended. " +
  "Do not wait for it and do not assume it succeeded. Carry on without it, and say plainly what " +
  "you could not do if it mattered.";
