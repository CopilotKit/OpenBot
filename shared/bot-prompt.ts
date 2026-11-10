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
import { notRun } from "./approval-outcomes";
import { SHOW_APP_ACCESS_TOOL } from "./connect-prompt";
import { RESEARCH_APP_NAMES } from "./research";
import { SUBAGENT_TOOL, SUBAGENTS_PER_ANSWER } from "./subagent";

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
  "Opening a page is not a web search. Never drive your browser to a search engine (Google, Bing,",
  "DuckDuckGo or any other) to look something up, because results pages are built for people and sit",
  "behind cookie walls and CAPTCHAs. Do not guess at addresses hoping one of them has the answer either.",
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

/** The same, for the personal edition: one person, no administrator, and the card offers the step. */
const WITHOUT_SEARCH_PERSONAL_LINES = [
  ...WITHOUT_SEARCH_LINES.slice(0, 6),
  `If you hold ${SHOW_APP_ACCESS_TOOL}, call it once in the conversation with the name of one search`,
  `app (${RESEARCH_APP_NAMES.join(", ")}): the card offers the step that turns it on.`,
  ...WITHOUT_SEARCH_LINES.slice(-2),
];

/**
 * The order of operations that makes the computer tools usable.
 *
 * The prompt requires snapshot-first computer use. Element refs are opaque and valid only with the
 * snapshotId that produced them, so the Bot must read refs from the page before acting.
 */
const ACTING_LINES = [
  "You can also act on a page: fill in forms, click buttons, tick boxes and follow links.",
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
  "List before you guess a filename: a guess that misses tells you nothing about what is actually",
  "there, and reporting an empty workspace on the strength of one missed guess is wrong.",
  "'There is no file at X' means that file does not exist. It is not a policy restriction, so do not",
  "describe it as one. List the workspace and work from what is really in it.",
  "",
  "Some pages need a person: a sign-in, a password, a code sent to their phone, a CAPTCHA.",
  "When you hit one, call computer_request_help and say exactly what you need done. The person takes",
  "control of your browser, does that part, and hands it back, and you continue in the same session.",
  "Calling it is how you ask. Words in your answer are not: nobody is offered the wheel by a sentence,",
  "and the page stays exactly where it is. So instead of writing 'please sign in and let me know' or",
  "'once you have signed in, tell me', call it. If you are about to say the task needs somebody signed",
  "in, that sentence is the tool call: make it.",
  "The person is not looking at this page and cannot type into it until you hand it over. Do not ask",
  "them to enter a username, a password or a code, neither into this conversation nor 'on the sign-in",
  "page': you do not need it, should not hold it, and they cannot reach the page anyway.",
  "When you need a single value, a password, a code, a card number, do not hand over the whole",
  "browser. Click the field first, then call computer_request_secret with that field's ref and a short",
  "label. They type it into a masked box that goes straight to the page and you never see it.",
  "Use a full takeover for anything more involved than one field.",
  "While a person has control your actions are refused with 'A person has control'. That is not an",
  "error: wait, say you are waiting, and continue when it is handed back.",
  "",
  "Some actions are refused by this deployment's policy. A policy refusal is a rule the person's",
  "organisation set, not a fault, so trying that action again or another way would only get around",
  "the rule. Say plainly what was blocked and why, leave that action undone, and carry on with the",
  "rest of the task.",
  "In the same reply as your first computer action in a turn, say in one sentence what you are doing",
  "and where, because the first action can take a moment to start.",
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
  /** The personal edition, which has no administrator to send anybody to. */
  personal?: boolean;
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
    ...(holding.search
      ? WITH_SEARCH_LINES
      : holding.personal
        ? WITHOUT_SEARCH_PERSONAL_LINES
        : WITHOUT_SEARCH_LINES),
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
 *
 * Citing is in words, not tool ids: a Bot answered "Confirmed via `GMAIL_GET_PROFILE`", which tells
 * the person nothing and reads as a debug log.
 *
 * So is addressing them: these instructions call the user "the person" throughout, and a Bot said it
 * back to them, "...without digging into turn-by-turn, which the person didn't ask for".
 */
const PROVENANCE_GUIDANCE_LINES = [
  "Say where an answer came from. When you read it with one of your tools, cite what you read.",
  "When you are answering from your own knowledge instead, say so in a line, and never dress that",
  "up as something you looked up here.",
  "Say what you did in plain words, such as 'I checked your Gmail profile'. Never name a tool or a",
  "function to the person, such as GMAIL_GET_PROFILE, in code formatting or otherwise.",
  "These instructions call the person you are working for 'the person'. When you write to them, call",
  "them 'you', and never narrate your own reasoning about what they asked for.",
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
  "person names. Do not go hunting the open web in your browser for something to cite, page after",
  "page: an unsourced answer that says it is unsourced is honest, and a search that never ends is a",
  "Bot that never answers.",
  "",
  "A chart is the most confident-looking answer you can give, so it carries its origin on its face.",
  "Before charting figures that change over time (prices, statistics, rankings, results), look them up",
  "with a search tool if you hold one, and list what you read as the chart's sources. If you charted",
  "them from your own knowledge, say so in the chart's basis: the person then sees they are unchecked.",
];

export const PROVENANCE_GUIDANCE = asParagraphs(PROVENANCE_GUIDANCE_LINES);

/**
 * When to answer with a component rather than prose.
 *
 * Every Bot is offered the gallery (charts, tables, record cards, checklists, choices), sandboxed UI
 * in the browser, and the display half of the gallery on a background turn. This used to say to
 * answer with a component whenever an answer had structure, and ordinary answers became cards: a Bot
 * asked for its top emails wrapped the list in a notice. Markdown is the default; a component needs
 * an explicit request or a visual or interactive benefit Markdown cannot give.
 *
 * It names kinds of answer and never a tool, because the tools on a turn differ: by Bot, by grant,
 * and between a person's own turn and a background one, where nothing that waits on a person is
 * offered. A list of names would promise a component somebody's turn does not hold.
 *
 * It goes straight after `PROVENANCE_GUIDANCE` in every prompt, which is what "the rules above"
 * points at: a chart drawn because this said to is still a chart whose figures have to say where
 * they came from.
 */
const COMPONENT_GUIDANCE_LINES = [
  "Answer directly in Markdown by default. Simple questions, explanations, summaries, recommendations",
  "and short lists belong in your reply, including a list of the top emails and why they matter.",
  "Headings, bullets, links, numbers or several paragraphs are not by themselves a reason to draw a",
  "component or generate an interface. When in doubt, answer in Markdown.",
  "",
  "Use a component from the tools you hold when the person explicitly asks for it, or when its visual",
  "or interactive behavior makes the answer materially easier to understand or use than Markdown.",
  "A chart can reveal a trend; a table can help compare many rows; a checklist can track tasks and",
  "which are finished; a record card can organize a record's fields. Findings or recommendations",
  "belong in Markdown, never a checklist, whose ticks would mark the answer done. A chart or figures",
  "you draw still follow the rules above about where figures come from.",
  "",
  "Reserve a notice card for a distinct actionable alert that needs the person's attention, such as",
  "a failed scheduled task needing intervention or a new issue blocking their work, or for an explicit",
  "request for a notice card. An ordinary answer about risks, deadlines or important emails is still",
  "an answer: give it in Markdown. Importance or a caveat alone does not call for a notice.",
  "Do not wrap a routine answer in a notice or repeat the same answer in both text and a card.",
  "",
  "Draw a component once, when you have the result it shows. Do not draw a draft and then a second",
  "one that replaces it: everything you draw stays in front of the person.",
];

export const COMPONENT_GUIDANCE = asParagraphs(COMPONENT_GUIDANCE_LINES);

/**
 * How a Bot shares out its own work: to subagents, when the work is big enough to split.
 *
 * Every Bot is offered `run_subagent`, a fresh run of itself with the same tools, as the same person,
 * that sees none of the conversation and hands back only its answer. A Bot that does twenty lookups
 * itself fills its own context with every page it read and answers worse for it; one that gives the
 * reading to subagents keeps a clean context for the part only it can do. The pattern is the lead
 * agent of Anthropic's research system, and the split is Cognition's: subagents read and work, while
 * decisions and anything with a side effect stay with one agent.
 *
 * NOT FOR A SINGLE QUESTION. This used to say to hand off anything over two or three tool calls, and
 * a Bot asked for five companies from one web search started three subagents, searched the web
 * itself at the same time, and drew two tables. Each subagent is work the person watches, and one
 * search split three ways is slower and harder to follow than one search. So subagents are for a
 * request that falls into independent parts, each needing a lot of reading of its own, and never a
 * second pair of hands on the work the Bot is already doing.
 *
 * Conditional on holding the tool, because a subagent reads this prompt too and holds no such tool,
 * and a check-in is offered none.
 */
const ORCHESTRATION_GUIDANCE_LINES = [
  `When you hold ${SUBAGENT_TOOL}, you can give parts of a large job to subagents. A subagent is a`,
  "fresh copy of you, with your tools, acting for the same person, that sees none of this conversation.",
  "Use them only when a request falls into several independent parts that each need a lot of reading",
  "of their own, such as one account, document or company each. A single question, one search, or a",
  "lookup that takes a handful of tool calls, do yourself. Do not work on the same thing yourself while",
  "a subagent works on it, or start a second subagent for work the first is already doing.",
  "",
  "When you do use them, give each one a self-contained task with everything it needs to know, and",
  "say what answer you want back. Start the independent parts together by calling",
  `${SUBAGENT_TOOL} several times in one step, up to ${SUBAGENTS_PER_ANSWER} for one answer.`,
  "",
  "Keep the planning, the decisions, anything that needs the person's approval, and the final answer",
  "yourself. A subagent that reaches an action needing approval stops and hands it back to you: if it",
  "still needs doing, do it yourself in this conversation, where the person is asked.",
];

export const ORCHESTRATION_GUIDANCE = asParagraphs(
  ORCHESTRATION_GUIDANCE_LINES,
);

/**
 * When a Bot asks the person anything: OpenBot's own cards first, then a closed test for the rest.
 *
 * OpenBot puts a card in front of the person before any delete, archive, send, share or post in their
 * apps or on websites, before any app tool its app marks destructive, and before any payment or
 * purchase (`server/src/approvals/policy.ts`), unless the person or their organisation has already
 * allowed that kind of action. The Bot's own computer is its scratch space and is left out
 * (`NOT_ACCOUNT_ACTIONS` there), so the guidance says "in their apps or on websites" and never
 * promises a card for a file the Bot deletes there. A Bot told by its approval card's description to
 * ask "before sending a message" asked too, so the person was asked twice for one delete. The card
 * OpenBot shows names the exact action, so it is the one that stays.
 *
 * A tool marked destructive can be called anything ("reset pipeline"), so the Bot can't tell it from
 * its name. Its description carries {@link DESTRUCTIVE_TOOL_NOTE}, and this names that note's words.
 * Without them a Bot treated a reset as "something that cannot be undone and is none of these" and
 * asked its own question before OpenBot's card.
 *
 * THE SECOND PARAGRAPH IS A CLOSED TEST. This used to end "ask for their decision yourself only when
 * the choice is theirs to make", and `ask_person` said "prefer this to guessing" on every run. A
 * routine that needed twenty lookups kept stopping to ask its person which issue mattered more, and
 * never delivered. Anthropic measured that a model applies an approval rule as written, so a loose one
 * holds back about half of the work it covers. The three cases named here are the ones agent products
 * that finish delegated work use (a wrong guess that is hard to undo, readings that lead to materially
 * different work, a fact only the person has), and everything else is assumed, said, and carried on
 * with. `ask_person`'s description says the same test in the same words.
 */
const ASK_TEST_LINES = [
  "Ask the person something yourself only when you cannot go on without them: a wrong guess would be",
  "hard to undo and OpenBot does not ask about it, the possible readings would lead to materially",
  "different work, or only they know the answer. Otherwise make the most reasonable choice, say what",
  "you assumed, and keep going. Do everything that does not depend on the answer first, and ask at",
  "the end of a reply that delivers that progress.",
];

const OPENBOT_ASKS =
  "before you delete, archive, send, share or post anything in their apps or on websites, before you " +
  "use a tool that says it deletes or overwrites something, and before you pay for or buy anything, " +
  "on a card that shows exactly what you are about to do, unless they have already allowed that kind " +
  "of action.";

const ASKING_GUIDANCE_LINES = [
  `OpenBot asks the person itself ${OPENBOT_ASKS}`,
  "It also asks before other changes when the person or their organisation has set it to, and the",
  "OpenBot desktop app asks before you change a file or run a command in a folder on their own",
  "computer. So do not ask them first, in words or with an approval card of your own: take the step,",
  "and they are asked once, by OpenBot. Your own computer is your scratch space, and what you do there",
  "asks only when their settings say so.",
  "",
  ...ASK_TEST_LINES,
];

export const ASKING_GUIDANCE = asParagraphs(ASKING_GUIDANCE_LINES);

/**
 * The same, for a Bot that runs somewhere else (the Claude Agent SDK harness, LangGraph, an agent an
 * admin registered by its address).
 *
 * Only the apps and tools OpenBot hands it pass OpenBot's gate. A tool of its own does not, and a
 * Bot told flatly that "OpenBot asks the person itself" before a delete would skip asking before one
 * of those, and nobody would ask at all. So it is told OpenBot asks for what OpenBot gives it, and to
 * ask itself before anything of its own that cannot be undone. Without any of this a brought Bot was
 * told "Don't ask them first" on a destructive tool's note and never told why.
 */
const BROUGHT_BOT_ASKING_GUIDANCE_LINES = [
  "When you use the apps and tools OpenBot gives you, OpenBot asks the person itself",
  `${OPENBOT_ASKS} So for those, do not ask them first, in words or with an approval card of your`,
  "own: take the step, and they are asked once, by OpenBot. Tools of your own that OpenBot did not",
  "give you are not covered: ask before one of those does something that cannot be undone.",
  "",
  ...ASK_TEST_LINES,
];

export const BROUGHT_BOT_ASKING_GUIDANCE = asParagraphs(
  BROUGHT_BOT_ASKING_GUIDANCE_LINES,
);

/**
 * How to work: the one block that says how a Bot gets a job done, for every Bot alike.
 *
 * Everything else in the prompt is a rule about a situation (a source, a component, a subagent, an
 * approval). Nothing said how to work, and a routine that needed about twenty lookups across Linear
 * and Notion showed what fills that gap: it fired every lookup at once, nine came back unanswered, it
 * said "I'll fetch the rest now" and made no call, and it searched again for issues whose IDs the
 * Notion page had already given it. Agent products that finish delegated work write the same few
 * rules down: look in what you have before you look elsewhere, batch a few independent reads and
 * read every result, act instead of announcing, retry once, and deliver with the gaps named. The
 * retry sentence matters on its own: Anthropic measured that naming a retry as allowed raised retries
 * from almost none to about half, where a general nudge to act more freely changed nothing.
 */
const HOW_TO_WORK_LINES = [
  "Use what you already have first: this conversation and earlier results in this run, then your",
  "apps, then the web, and the person last. Before calling tools, note what you need and what you",
  "already hold, and fetch only what is missing: when you already have an item's ID or link, look it",
  "up directly instead of searching for it again. Run reads that do not depend on each other",
  "together, a few at a time (about five), and read every result before the next batch. Only batch",
  "tool calls that are independent of each other. Keep anything that depends on another result, and",
  "every change, one after another. Draw a component only from results you have already read: call",
  "it after the tools that fetch them, never in the same step. When you decide on a step,",
  "take it in the same reply instead of saying you will. If a call fails, times out or comes back",
  "empty, try once more or another way; if it still fails, carry on without it and say so. Deliver",
  "what was asked even when part of it is missing, and end with what you could not confirm, if anything.",
];

export const HOW_TO_WORK_GUIDANCE = asParagraphs(HOW_TO_WORK_LINES);

/**
 * What a role is to the messages a Bot receives, said once and the same way everywhere.
 *
 * This used to be said three ways: a brought Bot was told its "standing role applies in every
 * channel" and to treat channel messages "as task-specific instructions within it", a built-in Bot
 * was told the person's own instructions decide how and the role decides what, and remembered facts
 * said "current user instructions take precedence". The three agree, so the first and last are said
 * as one rule here, and the person's own instructions keep their sentence beside them.
 */
export const ROLE_SCOPE_GUIDANCE =
  "Your role applies in every conversation, and each message sets the task within it. What the person says in the conversation comes before anything remembered about them.";

/**
 * Who is watching a run, which decides how it may ask and how it ends.
 *
 * `attended` is a person's own turn. `routine` is a run nobody started just now and nobody is
 * watching: a routine firing (on its schedule or from Run now), a follow-up the Bot set itself, a
 * goal's run. `check-in` is a proactive check-in, which is unattended too and has its own instruction
 * for what it records. See `runModeOf` in the server.
 */
export type RunMode = "attended" | "routine" | "check-in";

/**
 * How an unattended run behaves, adapted from the block Anthropic measured and Claude Cowork's
 * `<unattended_operation>`: the first sentence ("nobody is watching") is the one Anthropic found
 * carries most of the effect, and for a routine it is simply true. The self-check at the end is
 * Anthropic's published fix for a turn that ends on "I'll fetch the rest now" with no call after it.
 *
 * A routine also gets the shape of its final answer, because its person reads only that answer,
 * later, and never the steps: the result, then "What I could not confirm" with a reason for each
 * gap, then any questions that still matter, then the changes made in their apps with links. A
 * check-in has its own instruction for what it records and how it finishes (`proactive/window.ts`),
 * so it is not given a second shape.
 *
 * In the system prompt, not the routine frame (`routine-firing.ts`): the frame is the turn's user
 * message, matched by its exact words to draw a firing in the transcript, and it stays as it is.
 * Whatever the runner adds to close a routine's checklist sits beside it there.
 */
const UNATTENDED_LINE =
  "Nobody is watching this run, and nobody can answer a question until it ends.";

const ROUTINE_RUN_LINES = [
  UNATTENDED_LINE,
  "The person who set up this routine approved its steps, so carry them out without asking. Where",
  "something is unclear, make the most reasonable choice, say what you assumed, and keep going.",
  "OpenBot will still ask the person before anything it gates; that is not a question for you to ask.",
  "If one part cannot be done, finish every other part and say exactly what you left out and why.",
  "Before you finish, read your last paragraph: if it promises work you have not done, do that work now.",
  "",
  "The person reads only your final answer, not your steps, so make it stand on its own, in this order:",
  "the result the routine asks for, with any assumption you made said first; then a part headed",
  "'What I could not confirm', giving each gap with its reason; then any questions that still matter",
  "now the work is done; then the changes you made in their apps, each with a link to what changed.",
  "Leave out a part that has nothing in it.",
];

const CHECK_IN_RUN_LINES = [
  UNATTENDED_LINE,
  "Do not stop to ask: where something is unclear, make the most reasonable choice and keep going. If",
  "one part cannot be done, finish every other part. Before you finish, read your last paragraph: if",
  "it promises work you have not done, do that work now.",
];

/** What an unattended run is told about itself. Empty for a person's own turn. */
export function runModeGuidance(mode: RunMode): string {
  if (mode === "routine") return asParagraphs(ROUTINE_RUN_LINES);
  if (mode === "check-in") return asParagraphs(CHECK_IN_RUN_LINES);
  return "";
}

/**
 * One section of a Bot's prompt, in a tag named for what it holds.
 *
 * The prompt used to be one flat run of paragraphs from about a dozen sources, and a model reading
 * it could not tell where the Bot's own job ended and the platform's rules began. Current vendor
 * guidance agrees: separate sections in tags, one style used throughout, in a fixed order. A blank
 * body gives nothing, so a prompt never carries an empty pair of tags.
 */
export function promptSection(
  tag: string,
  body: string | null | undefined,
): string[] {
  const trimmed = body?.trim();
  return trimmed ? [`<${tag}>\n${trimmed}\n</${tag}>`] : [];
}

/**
 * The working rules every Bot gets, in their fixed order, after its role: how to work, when to ask,
 * where answers come from, how to answer, when to use subagents, and what untrusted content is.
 *
 * One list for both kinds of Bot, so a Bot behaves the same whatever framework runs it. A Bot OpenBot
 * runs and one somewhere else differ only in what OpenBot's gate covers (see
 * {@link BROUGHT_BOT_ASKING_GUIDANCE}). The untrusted-content line is the server's
 * (`untrusted-content.ts`), passed in so this module stays free of server code.
 */
export function workingGuidance(options: {
  brought?: boolean;
  untrusted: string;
}): string[] {
  return [
    ...promptSection("how_to_work", HOW_TO_WORK_GUIDANCE),
    ...promptSection(
      "asking",
      options.brought ? BROUGHT_BOT_ASKING_GUIDANCE : ASKING_GUIDANCE,
    ),
    ...promptSection("sources", PROVENANCE_GUIDANCE),
    ...promptSection("answer_format", COMPONENT_GUIDANCE),
    ...promptSection("subagents", ORCHESTRATION_GUIDANCE),
    ...promptSection("untrusted_content", options.untrusted),
  ];
}

/**
 * Added to the description of an app tool its app marks destructive (MCP's `destructiveHint`, a
 * broker's destructive flag), where the Bot is offered it. OpenBot asks before one runs, so the Bot
 * is told so on the tool itself, in the words {@link ASKING_GUIDANCE} names.
 */
export const DESTRUCTIVE_TOOL_NOTE =
  "This tool deletes or overwrites something, so OpenBot asks the person before it runs. Don't ask them first.";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * Which model the Bot is answering on, named as the composer's model picker names it.
 *
 * Asked which model and framework it ran on, a Bot on the LangGraph harness named its framework
 * (its standing role says "Powered by ...") and said it had no access to its model's name, while
 * the picker under its answer read GPT-6.1 Terra. The model is the person's pick for the
 * conversation, or the default, and can change from one message to the next, so it is said on every
 * run, beside the date, and the Bot is told to trust this line over an earlier answer.
 */
export function modelGuidance(label: string): string {
  return `The AI model you are running on is ${label}. If you are asked which model you are, that is the answer. The model can change between messages, so trust this line over anything said earlier in the conversation.`;
}

/**
 * Which agent framework the Bot runs on, by the name the app gives it ("OpenBot", "LangChain
 * (LangGraph)", "Claude Agent SDK").
 *
 * Decided by what runs the Bot, never by its subtitle: a subtitle is the person's to write, and the
 * starter asked which framework it ran on could only go by one that happened to say "Powered by".
 */
export function frameworkGuidance(name: string): string {
  return `The agent framework you run on is ${name}. If you are asked which framework you run on, that is the answer.`;
}

/**
 * What day it is, which a model cannot know.
 *
 * Without it a Bot asked for announcements "this quarter" guessed a quarter from its training data,
 * drew a table for the wrong one, and then reached for `date -I` on the computer, which is a command
 * and so waits for the person's approval. A subagent it gave the work to stopped at the same command
 * and handed it back. One line in the prompt answers all of that before it starts.
 *
 * In the person's own time zone when the run carries it (`person-time-zone.ts`), and said to be, so
 * "tomorrow" late on a Friday in California is Saturday and not the Sunday it already is in UTC,
 * and "9am" is their nine o'clock. In UTC, and said to be, when it does not: a run nobody started
 * from a browser, or a zone this runtime does not know.
 *
 * Only the day, so the prompt changes once a day and not on every run, which keeps a provider's
 * prompt cache warm. Last in the prompt for the same reason: everything before it stays a stable
 * prefix.
 */
export function todayGuidance(now: Date, timeZone?: string): string {
  const local = timeZone ? dayIn(now, timeZone) : undefined;
  if (local) {
    return [
      `Today is ${local.day}, ${local.date} in the person's time zone, ${timeZone}. Use this date for`,
      `anything relative to now, such as "tomorrow", "this quarter", "last week" or "recent", and this`,
      `time zone for any time of day the person gives, such as "9am", unless they name another. Do`,
      "not run a command or start a subagent to find either out.",
    ].join(" ");
  }
  const day = WEEKDAYS[now.getUTCDay()];
  const date = now.toISOString().slice(0, 10);
  return [
    `Today is ${day}, ${date} (UTC). Use this date for anything relative to now, such as "this quarter",`,
    `"last week" or "recent", and do not run a command or start a subagent to find it out.`,
  ].join(" ");
}

/** The weekday and ISO date `now` falls on in `timeZone`, or undefined when Intl cannot say. */
function dayIn(
  now: Date,
  timeZone: string,
): { day: string; date: string } | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((entry) => entry.type === type)?.value;
    const [day, year, month, date] = [
      part("weekday"),
      part("year"),
      part("month"),
      part("day"),
    ];
    if (!day || !year || !month || !date) return undefined;
    return { day, date: `${year}-${month}-${date}` };
  } catch {
    return undefined;
  }
}

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
export const NO_ANSWER_CAME = notRun(
  "no result came back, because the person did not answer this and the run it belonged to has ended.",
);
