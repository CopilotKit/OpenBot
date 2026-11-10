/**
 * One turn of a built-in Bot that sends 20 lookups in one step, as the Intelligence gateway replays
 * it to a browser and as the thread's store answers for it.
 *
 * Shaped as the frames of a real run are (see `ask-person-replay.fixture.ts`, captured from one): the
 * calls stream under the message that makes them, each answer is a TOOL_CALL_RESULT under its own
 * message id, and the store keeps each answer as `<call>-result`. The step is the one found live: a
 * cycle-planning request whose team, cycle, status, label, issue-page and page lookups answered
 * quickly, and whose keyword searches were still running when the person came back to it.
 */

const RUN = "4f2d7c1e-9a35-4c8e-8f61-2b7d3c9e5a10";
const CALLING = "8c1b5f3a-2e47-4d9b-a6c0-7e3f9d2b1a54";
const ANSWERING = "b2e9d4c7-5f18-4a3e-9c6b-0d7a8e1f2c39";

export const ANSWER_TEXT =
  "Every lookup answered. Here is the matched list and the ranked triage.";

/** The 20 lookups, quick ones first, the way the Bot asked for them. */
export const LOOKUPS: { id: string; name: string; args: string }[] = [
  ["list_teams", "{}"],
  ["list_cycles", '{"team":"EGG"}'],
  ["list_issues", '{"team":"EGG","page":1}'],
  ["list_issues", '{"team":"EGG","page":2}'],
  ["list_issues", '{"team":"EGG","page":3}'],
  ["list_issues", '{"team":"EGG","page":4}'],
  ["list_statuses", "{}"],
  ["list_labels", "{}"],
  ["fetch_page", '{"title":"Cycle 65"}'],
  ["fetch_page", '{"title":"Cycle 65 Candidates"}'],
  ["search_issues", '{"query":"AI Dev NYC"}'],
  ["search_issues", '{"query":"Monaco"}'],
  ["search_issues", '{"query":"Product Leader ABM"}'],
  ["search_issues", '{"query":"master ICP doc"}'],
  ["search_issues", '{"query":"Luma job title backfill"}'],
  ["search_issues", '{"query":"Contact Us replies"}'],
  ["search_issues", '{"query":"version B no link reply"}'],
  ["search_issues", '{"query":"Warmy"}'],
  ["search_issues", '{"query":"Smartlead"}'],
  ["search_issues", '{"query":"Scoring"}'],
].map(([name, args], index) => ({
  id: `toolu_01Lookup${String(index).padStart(2, "0")}Parallel`,
  name: name as string,
  args: args as string,
}));

/** How many of the 20 had answered when the person came back: all but the 9 keyword searches. */
export const ANSWERED_EARLY = 11;

/** What lookup `index` answered, as the Bot read it. */
export function answerOf(index: number): string {
  const lookup = LOOKUPS[index];
  if (!lookup) throw new Error(`No lookup ${index}`);
  return `${lookup.name} ${lookup.args}: EGG-${500 + index} found`;
}

function events(threadId: string) {
  return (fields: Record<string, unknown>) => ({
    ...fields,
    threadId,
    runId: RUN,
  });
}

function answerEvent(threadId: string, index: number) {
  const lookup = LOOKUPS[index];
  if (!lookup) throw new Error(`No lookup ${index}`);
  return events(threadId)({
    type: "TOOL_CALL_RESULT",
    messageId: `${lookup.id}-result`,
    role: "tool",
    toolCallId: lookup.id,
    content: answerOf(index),
  });
}

/** The turn up to the moment the person came back: every call, and the first 11 answers. */
export function lookupsReplayStart(threadId: string): unknown[] {
  const event = events(threadId);
  return [
    event({ type: "RUN_STARTED" }),
    ...LOOKUPS.flatMap((lookup) => [
      event({
        type: "TOOL_CALL_START",
        toolCallId: lookup.id,
        toolCallName: lookup.name,
        parentMessageId: CALLING,
      }),
      event({
        type: "TOOL_CALL_ARGS",
        toolCallId: lookup.id,
        delta: lookup.args,
      }),
      event({ type: "TOOL_CALL_END", toolCallId: lookup.id }),
    ]),
    ...LOOKUPS.slice(0, ANSWERED_EARLY).map((_, index) =>
      answerEvent(threadId, index),
    ),
  ];
}

/** The rest of the turn: the 9 searches answering, then the Bot's answer. */
export function lookupsReplayEnd(threadId: string): unknown[] {
  const event = events(threadId);
  return [
    ...LOOKUPS.slice(ANSWERED_EARLY).map((_, offset) =>
      answerEvent(threadId, ANSWERED_EARLY + offset),
    ),
    event({
      type: "TEXT_MESSAGE_START",
      messageId: ANSWERING,
      role: "assistant",
    }),
    event({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: ANSWERING,
      delta: ANSWER_TEXT,
    }),
    event({ type: "TEXT_MESSAGE_END", messageId: ANSWERING }),
    event({ type: "RUN_FINISHED" }),
  ];
}

/**
 * The turn as the store holds it: with `answered` of the 20 answers, and the Bot's answer once all
 * of them are in.
 */
export function lookupsStored(
  userId: string,
  answered: number = LOOKUPS.length,
): unknown[] {
  return [
    {
      id: userId,
      role: "user",
      content:
        "Read the current cycle and its planning pages, match them up and rank the triage list.",
    },
    {
      id: CALLING,
      role: "assistant",
      content: "",
      toolCalls: LOOKUPS.map((lookup) => ({
        id: lookup.id,
        type: "function",
        function: { name: lookup.name, arguments: lookup.args },
      })),
    },
    ...LOOKUPS.slice(0, answered).map((lookup, index) => ({
      id: `${lookup.id}-result`,
      role: "tool",
      toolCallId: lookup.id,
      content: answerOf(index),
    })),
    ...(answered === LOOKUPS.length
      ? [{ id: ANSWERING, role: "assistant", content: ANSWER_TEXT }]
      : []),
  ];
}
