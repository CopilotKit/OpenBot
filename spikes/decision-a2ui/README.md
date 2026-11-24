# Gemini Decision 1 and A2UI spike

This directory contains a standalone A2UI v1.0 experiment. Read [Findings](FINDINGS.md) for the verdict and measurements, [Source map](SOURCES.md) for the upstream contracts, and [benchmark.ndjson](benchmark.ndjson) for the individual live runs.

The follow-up [OpenBot option-count benchmark](openbot-options/README.md) tests live selection with the real Canvas catalog and its 69-component parent.

For the two-stage, domain-independent path in the desktop debug app, see [the live OpenBot demo](OPENBOT-DEMO.md).

## Porting to the Antigravity canvas showcase

Start with OpenBot’s [content planner](../../agent-antigravity/src/canvas_content.py) and [Decision composer](../../agent-antigravity/src/decision_canvas.py). The planner produces validated content and scoped revisions. The composer builds typed questions from that content and the active catalog, then turns the answers into canonical A2UI v1.0 operations. The [OpenBot routing and event code](../../agent-antigravity/src/main.py) shows where these stages run and how the browser’s catalog reaches the harness. For the original typed-message ingress experiment, see [the SDK adapter](sdk.ts).

In the CopilotKit showcase, use its own model selector, catalog export, and `render_ui` transport. OpenBot uses an activity snapshot and a new versioned surface ID per turn. It retains the previous content in memory, so a port that updates a single surface should seed validation from that surface and preserve its IDs and edited values. The Decision composer supports a bounded subset of catalog components. Editable form fields in the OpenBot spike are a local preview. [Antigravity canvas showcase](https://github.com/CopilotKit/CopilotKit/pull/8504)

## Run offline

Use Node.js 22.18 or later. The browser checks use a locally installed Google Chrome. Set `CHROME_PATH` to use another Chromium executable.

```sh
cd spikes/decision-a2ui
npm ci
npm run typecheck
npm test
npm run test:browser
npm run demo
```

Open [the local demo](http://127.0.0.1:4173). Choose **Mocked decisions** or **Express fixture**, then render Settings, Results, or Confirmation. In Results, click **Birch** to update the existing surface. The mocked Decision path also supports clicking Confirm. Both modes use the packaged Lit renderer. The demo uses fixtures and makes no model requests.

## Run live

Set `GEMINI_API_KEY` or `GOOGLE_API_KEY` in the calling environment. See [.env.example](.env.example). For this spike, when both are populated, `GOOGLE_API_KEY` takes precedence.

```sh
npm run test:live
npm run build
npm run bench -- --runs=2 --browser
```

For a local ignored `.env` file, use `node --env-file=.env --test live.test.ts` and `node --env-file=.env bench.ts --runs=2 --browser`. `test:live` skips when a key is absent. The benchmark requires a key, prints one JSON record per attempted turn, and makes at most 16 API calls per repeat. `--runs=1` makes a shorter run. Omitting `--browser` uses the SDK message processor and a synthetic action. Browser mode checks the Chrome DOM after replay and takes the result follow-up from a real click.

The live paths are fixed to `gemini-decision-1` and the separate Express comparison model `gemini-3.5-flash-lite`. A failed turn is recorded and the benchmark continues. Both SDK clients disable retries for this experiment. Benchmark output includes timing, counts, catalog component IDs, allowlisted decision labels and confidence. It excludes API keys, raw model output, and request bodies.

## Files

- [decision.ts](decision.ts) maps known catalog components to choices, compiles accepted answers, and handles actions.
- [sdk.ts](sdk.ts) negotiates the catalog and implements canonical message ingress with the SDK state validator.
- [live.ts](live.ts) uses the documented Gemini APIs. [express.ts](express.ts) uses the A2UI Express prompt and real stream parser.
- [fixtures.ts](fixtures.ts), [spike.test.ts](spike.test.ts), and [browser.test.ts](browser.test.ts) cover offline behavior. [bench.ts](bench.ts) runs both models.
