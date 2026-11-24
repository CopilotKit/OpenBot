# General-purpose Decision canvas in OpenBot

In **OpenBot Canvas Debug**, start a Personal Assistant conversation and pick a canvas starter or describe what to build. Canvas generation and edits use the Decision pipeline by default. Add `Express:` when you want to run the Express comparison.

The demo also includes Jerel's **Q4 team goals**, **Meetup sign-up form**, and **Weekly sales report** starters with their original wording. Missing figures in the starters can be filled with labeled examples. The sign-up form is an editable preview with no submission or storage. [Original starter prompts](https://github.com/CopilotKit/CopilotKit/blob/33bb4617bc9606a0b48767fab0544bcb4e7d8107/examples/showcases/antigravity-a2ui-canvas/src/lib/canvas.ts)

## Try it

```text
Plan a three-day escape to Lisbon for two people who like food, design and wandering. Balance a few memorable experiences with time to get lost. Include one splurge, a rainy-day alternative and a realistic spending estimate. Help me adjust the plan if it feels too busy.
```

Follow up in the same conversation.

```text
Saturday feels too busy. Keep the food and design focus, cut it to two main stops, and show how that changes the spending estimate.
```

For a different domain, open a fresh conversation.

```text
Create a tabbed volunteer orientation for a small library on the canvas. Cover desk handover, fixing shelf gaps, and event setup. Put a checklist of end-of-shift tasks in one tab.
```

## Architecture

OpenBot selects this path in `CanvasAgent`, alongside the Express path. Express uses the SDK's prompt and text parser contract. Decision sends typed questions through its own API and compiles the returned answers directly to A2UI v1.0. Both paths use the active OpenBot catalog and the existing renderer. The Decision path calls `RendererState` directly for catalog and topology validation. The starter prompts select the same composer. [SDK inference-format contract](https://github.com/a2ui-project/a2ui/blob/289923cb2e5a2ba72cab21f0df675a55cc5b657f/python/a2ui_agent/src/a2ui/inference_format.py#L32-L63)

1. **Content.** Gemini 3.5 Flash-Lite writes a validated subject-neutral document of sections, prose, entries, and numeric data. The schema has no widget names, wire messages, or action handlers. On a revision, it returns section edits that the harness merges, preserving the untouched sections.
2. **Presentation.** Gemini Decision 1 chooses layout and per-section presentation where there is a choice. The composer derives eligible alternatives from the content's shape and its supported components. It uses the manifest that Canvas Debug sends, with all 66 catalog entries available to describe, and narrower options for each slot. A slot with a single eligible representation is compiled directly.
3. **Compilation.** General builders emit A2UI messages for stacked sections, tabs, lists, tables, charts, checklists, editable amount breakdowns, local text inputs, and revision buttons. Python A2UI validates the messages and topology against the actual catalog before publishing one completed batch to the unchanged Canvas Debug renderer.

The compiler has component-specific builders and no workflow-specific branches. Its UI capabilities are bounded by those builders. A typed request can ask the assistant to gather information before drawing. The Decision composer receives the request and supporting context the assistant passes it. Data typed into a local control is available to that canvas. Include adjusted values in a follow-up that needs the planner to use them. The harness holds the previous content in memory for revisions. Start a fresh request after a harness restart.

## Live verification

One live replay per turn using the full OpenBot manifest. Times end when the harness finishes validation and exclude OpenBot transport and browser rendering.

| Turn | Content generation | Decision 1 | Canvas ready |
| --- | ---: | ---: | ---: |
| Lisbon itinerary | 4.82 s | 0.53 s | 5.54 s |
| Lisbon Saturday and budget edit | 2.53 s | 0.62 s | 3.36 s |
| Dinner planning | 4.34 s | 1.05 s | 5.57 s |
| Fusion explainer | 4.75 s | 0.95 s | 5.86 s |
| Tabbed library orientation | 3.12 s | 0.65 s | 3.90 s |
| Build performance dashboard | 2.92 s | 0.50 s | 3.54 s |

Native Canvas Debug also rendered the original Lisbon prompt and the Saturday edit, retaining all three days and the rainy-day section. Changing the food budget from €220 to €240 changed its illustrative total from €1,030 to €1,050. The test value was restored afterward.

The three Jerel pills rendered in the native app without prefixes. A plain-language Q4 revision rendered a new version, and the meetup preview exposed editable text, email, and number fields. One repeat of the meetup request failed in the content planner. Clicking the pill again rendered a preview in place of the sales canvas.

The previous Q4 and Weekend Spending timings measured a separate fixed-content prototype. The content planner accounts for most of the time in this path. Presentation choices can be close because several components can display the same information. The evaluation verifies that the selected layouts compiled and used the expected content affordances on these prompts. It does not score the factual freshness of the generated content.

[Content planner](../../agent-antigravity/src/canvas_content.py) · [Decision composer](../../agent-antigravity/src/decision_canvas.py) · [Live measurements](openbot-general-results.ndjson)
