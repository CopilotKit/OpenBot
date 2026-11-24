# Can Gemini Decision 1 replace A2UI Express?

**Verdict: feasible with a small backend/generator adapter.** The existing inference-format factory accepts a prompt writer and text parser. It has no hook for typed request construction, model invocation or typed results. A Decision 1 strategy can use the existing `A2uiGenerator`, negotiated catalog and transactional state validator by supplying compiled canonical messages beside the parser. The spike exercised that boundary live with the stock v1.0 Basic catalog and the unchanged Lit renderer.

**Confidence is high for the SDK boundary and bounded UI.** Two live runs confirmed routing, component choices and a click-driven update. Coverage and relative performance beyond this small catalog policy remain open. An upstream format contract with a typed, async invocation or result hook would change the pure-plugin classification. Production fitness would need labeled support and refusal cases, more catalogs, and a transport-level performance comparison.

A follow-up tested live component selection using [OpenBot’s Canvas catalog and its 69-component parent](openbot-options/README.md). The [two-stage OpenBot demo](OPENBOT-DEMO.md) uses domain-independent content and component builders and reports separate content and presentation timings.

## Actual SDK boundary

Tested with `@a2ui/agent@0.1.0`, `@a2ui/web_core@0.15.0`, `@a2ui/lit@0.15.0`, and `@google/genai@3.6.1`. Compared published code and declarations with A2UI main at `289923cb2e5a2ba72cab21f0df675a55cc5b657f`. The inspected jev2ui commit was `b0e38743dcefaa2fc315737229a474ba5be7b067`. Release/source distinctions, Python and Dart cross-checks, conformance tests, and permalinks are in the [source map](SOURCES.md).

```text
CatalogConfig → A2uiGenerator.createProcessor → negotiated catalog + RendererState
                                                    │
     Express     SDK prompt/skills → app calls Flash-Lite → text chunks → Express parser
                                                                           │
     Decisions   request + state → typed questions → Decision 1 → canonical compiler
                                                                           │
                    RendererState.apply + checkTopology ←───────────────────┘
                                     │
                   A2UI v1.0 messages → web_core MessageProcessor → stock Lit
                                     ↑
                    next turn ← validated action envelope ← user click
```

1. **Catalog and examples.** `CatalogConfig` wraps a loaded catalog and optional transforms. `A2uiGenerator.createProcessor` negotiates active catalogs from renderer capabilities, validates canonical example messages via `validatePayload`, and creates a processor. Express builds signatures and rules via its `PromptGenerator`, decompiles canonical examples with `ExpressDecompiler`, and supports optional `SkillGenerator` output. The spike uses the packaged Basic catalog and its schema-only copy on the agent side.
2. **Invocation and input.** The caller places `processor.promptSnippet` in a model request, provides the request and history, and invokes the model. `InferenceFormatFactory.createFormat(catalogs, examples?)` receives those catalogs and examples. `InferenceFormat` provides `promptGenerator` and `createParser()`. The factory receives no live request, history, or renderer state. `ParseOptions.state` allows state-aware validation on the parser facade. The synchronous `compile(string, isFinal?)` receives only the text block.
3. **Translation and streaming.** A TypeScript parser implements `unwrap`, `wrap`, `hasFormatContent`, `compile` and `decompile`. Compile can emit canonical messages directly from a textual notation. The response API still accepts strings via `parseResponse(string)` or `openStream().feed(string)`. Express supports progressive streaming in the tested release. Its stream can emit messages before all referenced children exist and finishes topology checks as blocks close. In batch mode, the SDK applies the complete response in a state transaction.
4. **Validation, state and delivery.** The Decision path uses `createState` and `acceptsState` from the real request processor, then runs `state.transaction(() => state.checkTopology(state.apply(messages)))`. These are the validation primitives the SDK batch parser calls. They check envelopes, catalog components and functions, IDs, and the surface graph. They roll back on an invalid batch. `validatePayload` is stateless and permits some update-only references to prior UI, so the adapter uses a persistent `RendererState`. The client receives ordinary v1.0 messages through `MessageProcessor.processMessages` and renders the resulting model with Lit.
5. **Actions, retries and repair.** The renderer provides an `ActionPayload`. With the pinned release, the spike’s host wraps it in the v1.0 action envelope. The adapter validates it with `ActionMessageSchema`, checks that the action and source component are allowed on the existing surface, and passes the selected item and prior state to the next decision request. Current main also has an inbound message processor for validated actions and RPC. Existing state, error and topology handling is reusable. Express compiler hints and streaming recovery are specific to Express. API retry and re-prompt policy belong to the caller. This spike uses one call per turn, with no repairs or fallback.

### Options

| Option | Finding |
| --- | --- |
| A. Pure format factory | The contract owns prompt text and parsing. It provides no provider hook or typed result ingress. |
| B. Format plus backend adapter | Possible with an application-owned adapter and a serialized decision envelope. A custom parser would have to decode that envelope and recover compilation context. This would add a text round trip and example translation obligations. |
| **C. Adjacent processor adapter** | **Selected.** [`acceptMessages`](sdk.ts) validates an already compiled batch using the same processor and state path as Express. The caller chooses the model strategy without replacing the generator. |
| D. Separate builder | Feasible, but handing unvalidated output straight to a renderer would leave SDK capabilities unused. The spike used the SDK’s negotiation, validation and state facilities. |

The smallest useful SDK addition would be a public `A2uiRequestProcessor.acceptMessages(messages, { state })` convenience method with the same state resolution, atomicity and topology checks as a complete parsed block. The app can already select the backend. A caller can emit several validated canonical batches as they become available without a text stream. Each Decision API response is itself one batch, and the SDK transaction is synchronous. No arbitrary async compiler interface is needed for this slice. The SDK sources and published entry points inspected expose Express, Direct JSON, and experimental text grammars. No official Decision 1 format or backend integration was found. [A2UI inference formats](https://a2ui.org/concepts/inference-formats/) · [Google’s Express and Jev article](https://developers.googleblog.com/fast-reliable-a2ui/)

**Jev2UI is precedent for the compiler strategy.** It formulates choices through `planQuestions` and its Markdown screen grammar, calls TypeSafe’s `systemOne` through `askJev`, and builds graphs and outbound messages in `runHybrid` and `runMock`. It bypasses the A2UI format factory. The project also uses Gemini separately for copy. Its compare view uses stock v0.9 Lit and Basic. The main demo has its own component sets, graph validator, renderer, and `defineComponent` extension. [Jev2UI source map](SOURCES.md#gemini-and-jev)

## Decision 1 API

The official name is **Gemini Decision 1**, model ID **`gemini-decision-1`**. The Gemini Developer API exposes beta `POST https://generativelanguage.googleapis.com/v1beta/decisions`, authenticated with `x-goog-api-key`. Google documents `GEMINI_API_KEY` or `GOOGLE_API_KEY` for the SDK and Developer API availability. The TypeScript client used `GoogleGenAI.decisions.create` with Developer API mode and `v1beta`. A live smoke request succeeded with the existing credential. It chose `settings`, confidence 0.999, 100 input tokens, 0 output tokens, 1,105 ms observed client time. [Model](https://aistudio.google.com/docs/models/gemini-decision-1) · [Decisions API](https://aistudio.google.com/docs/decisions-api) · [Authentication](https://aistudio.google.com/docs/api-key)

- `noul` returns yes probability 0.01–0.99 and confidence. `choice` returns a supplied key, per-key probabilities and confidence. `score` returns the expected rubric level, probabilities, a legend and confidence. A choice always ranks the supplied options, so the spike adds an explicit `other` option and applies a 0.70 threshold. HTTP errors, safety blocks and missing or invalid answers are handled as failures. The spike exercised only `choice` live.
- The shared input supports text and multimodal blocks. Request, app data, state and history use serialized text here. Each question scores independently against that input. A question that depends on an answer needs a later call, or pre-enumerated conditional questions whose unused answers are discarded. The spike uses up to five independent questions in one initial call and one on a follow-up.
- Documented limits are 1,000 questions, 2–255 choices or rubric levels per question, and 262,144 tokens including question instructions and options. The endpoint returns a single result with usage. We timed the client call and did not observe provider-side latency metadata. Decision 1 supplies no free-form copy, IDs or paths. A string can be picked from provided options. All displayed copy, IDs and bindings in the spike come from application data or code. [Question types, usage and limits](https://aistudio.google.com/docs/decisions-api#question-types) · [REST response](https://aistudio.google.com/api-reference/decisions/create-decision)

## Evaluation

One preliminary pass exposed a question-design problem. A settings request requiring a row got `Row` at 0.996 on its conditional question, while the family question chose `other` at 0.723. A plain results request got the intended child choices but only 0.570 on the results family. Explicitly describing supported arrangements in the family criteria and telling the model that app fixtures cover all families resolved both in the two measured repeats. The repeats reused the same requests and differ from an independent quality evaluation.

| Case | Decision 1 live, two attempts | Express live, two attempts |
| --- | --- | --- |
| Settings, stacked | 2/2 strict passes, actual text input and checkbox | 2/2 strict passes |
| Settings, side by side | 2/2, selected Row and both controls rendered | 0/2 strict, controls visible twice, required IDs or grouping differed |
| Selectable results with card detail | 2/2, List, repeated Buttons and Card | 0/2 strict, one parser/compilation failure and one SDK-valid UI that lacked the required IDs and clickable Birch |
| Plain results | 2/2, Column and inline text | 0/2 strict, SDK accepted both but browser assertions failed |
| Confirmation | 2/2, nested Card and primary Button | 0/2, both SDK validation errors |
| Birch click on existing surface | 2/2, real renderer action and canonical data update, no surface recreation | No live follow-up call. The initial screen either failed or had no matching Birch click target. The offline Express fixture passed. |
| Ambiguous / unsupported calendar | 4/4 explicit scope refusals, no messages | 0/4 for the defined refusal behavior. Both ambiguous turns errored. Both calendar turns emitted valid A2UI. |
| Missing, malformed, low-confidence answers | Injected offline. Rejected before mutation or delivery. | These cases exercise the Decision adapter’s typed response contract. |
| Pruned catalog | Offline. Removing Card and List suppresses those options. The plain results request compiles and the SDK client processor accepts it. | Baseline measured with the full Basic catalog. |

Tests also checked rollback on an unknown component or dangling reference, rejection of an update to a missing surface, and rejection of a forged selection ID. A separate test makes prompt or parser access throw and confirms the typed path still succeeds. The offline Chrome suite exercised the settings controls, confirmation, and Birch follow-up for both paths. The browser also caught a v1.0 compatibility detail that SDK validation alone missed. The schema accepted a legacy `path` object, but the pinned renderer displayed it literally in a text field. Emitting canonical `@path` bindings fixed the render. The SDK also rejects component IDs outside the v1.0 identifier rules.

### Measured comparison

[Individual benchmark records](benchmark.ndjson) cover two sequential repeats, seven initial requests per model per repeat, plus two Decision follow-up calls. Decision made 16 calls and Express made 14. An Express click attempt timed out locally. Zero retries, repairs or fallback calls were used. Express used `gemini-3.5-flash-lite`, v1beta `generateContentStream`, minimal thinking, default sampling, and a 2,048-token cap. Decision used v1beta `decisions.create`, the same app fixtures, and a closed option set. This compares two systems with different models, prompts and output work.

| Metric, measured model calls with canonical UI output | Decision, n=12 | Express, n=9 |
| --- | ---: | ---: |
| Client-observed API completion, ms | 272–998 (median 432) | 954–1,703 (median 1,338) |
| First SDK-renderable update, ms | 273–1,001 (median 434) | 876–1,702 (median 1,337) |
| Complete SDK output, ms | 273–1,001 (median 434) | 955–1,703 (median 1,339) |
| Input / output tokens | 225–686 / 0 | 6,051–6,059 / 33–360 |
| Estimated paid cost of these measured rows | $0.00073 total | $0.01687 total |

First SDK-renderable means a root with reachable, valid topology, or the first data update on the existing surface. A valid root can have pending content. The benchmark replays the completed output in Chrome and checks task-specific controls and text. Chrome timing is captured separately and excludes the model call. It is not a paint-time measurement. All 12 Decision UI outputs met their Chrome assertions. Express produced nine SDK-valid payloads, five SDK errors, and five successful content assertions among the nine payloads. The strict benchmark also requires designated component IDs, layouts and action contracts. Those requirements can penalize equivalent-looking screens.

The only repeated strict like-for-like success was stacked settings. Decision API/SDK-complete times were **678/690 ms** and **433/434 ms**. Express was **1,223/1,243 ms** and **1,672/1,673 ms**. The first and repeat calls were tracked. Provider cold starts were unobservable. Express reported cached input on some calls. Cost estimates use documented standard paid rates and returned usage, including Express cached tokens. The totals omit rejected calls without recorded usage and do not represent invoices. [Decision pricing](https://aistudio.google.com/docs/pricing#gemini-decision) · [Express model pricing](https://aistudio.google.com/docs/pricing#gemini-3.5-flash-lite)

## Reuse and next step

Catalog IDs and component availability come from negotiated metadata. The message ingress, API client, option membership checks and state handling are reusable. Component roles, required property bindings, alternate widget meanings, root topology, action names and per-family questions are handwritten. Repeated buttons and Card/Column/List combinations are bounded. New component semantics, cross-catalog layouts, arbitrary nesting, generating strings and general editing of existing surfaces remain outside this experiment. A new catalog with equivalent known entries can use the policy. A schema-compatible but semantically different replacement needs explicit mapping and tests.

The user request is supplied as model data. The compiler accepts only offered choices, validates probabilities and confidence, builds IDs and paths locally, and treats action data as untrusted. API errors and rejected decisions leave the existing UI intact. Application code remains responsible for authorizing any real side effect, sanitizing app-provided values and operating data, and deciding which renderer-local edits to ingest. This demo performs no real booking or other side effect.

The next step is to share the typed canonical-message ingress with the SDK maintainers and test one real application workflow behind an explicit strategy selector. Keep the same catalog and renderer, label enough supported and unsupported inputs to calibrate abstention, and measure first visible UI through the actual transport.
