/**
 * The tools a harness runs itself, inside its own run, and never hands to OpenBot or the browser.
 *
 * Claude Code's own `ToolSearch` and `Read`, which the Claude Agent SDK harness keeps for a full Bot
 * (`TOOL_SEARCH` and `READ_TOOL` in agent-claude-sdk/src/adapter.py; `harness-own-tools.test.ts`
 * holds the two lists together). Every other tool reaches that harness as a client tool, so a run it
 * ends with one of these still to answer has ended for a call of another kind in the same step, and
 * Claude Code runs this one once that call's result comes back. Nobody outside the harness answers
 * it, so it never makes the caller the one to answer.
 */
export const HARNESS_OWN_TOOLS: ReadonlySet<string> = new Set([
  "ToolSearch",
  "Read",
]);
