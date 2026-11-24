# Does the OpenBot catalog have too many choices?

**All 69 options fit, and they caused no accuracy drop on these component-selection tasks.** The full catalogs used substantially more input when the test sent each description with every question. Sending descriptions once as shared input retained accuracy in this sample and reduced input by 82%. Choosing safely on unsupported requests was the larger quality issue.

## Catalog verified from the application

The Canvas Debug exporter calls `exportA2UICatalog(OPENBOT_UI)`. Executing that call in the `canvas-spike` checkout at `8d08e956d9163781eadb4e6dc3147aa5ae65ced0` using `@copilotkit/react-core@1.88.0` returned `openbot/ui@1`, A2UI v1.0, with **66 components and 16 functions**. Exporting the same package’s `standardUI` returned `copilotkit/standard@1` with **69 components and 16 functions**. OpenBot removes `Map`, `Favicon`, `LinkCard` and `Citation`, and adds `Breakdown`. The 65 shared components have identical exported descriptions. The benchmark uses the exact exported names and descriptions. It treats functions separately from components.

The captured options below are sufficient to replay the benchmark from this branch. The exporter uses the frontend checkout to regenerate them. [Captured catalog options](catalog-options.json) · [Capture script](export-catalog.sh)

## Live results

Each batch sent 29 independent synthetic slot requests to the real `gemini-decision-1` endpoint. There were 24 supported cases shared by both catalogs, one supported catalog-specific case per catalog, and four unsupported requests per catalog. The six-option shortlist was chosen by hand from plausible alternatives and always included any acceptable answer. The first four conditions ran in rotated order across three repeats. The shared-description variant ran separately with the same cases and key. The repeated choices and confidences were identical within each condition, so the repeats measure timing variation on fixed inputs.

| Candidate set per question | Supported task selections per repeat | Client batch time, 3 calls | Input tokens per batch |
| --- | ---: | ---: | ---: |
| Six shortlisted OpenBot components | 25/25 | 565–647 ms | 10,271 |
| Full OpenBot, 66 components | 25/25 | 1,416–1,506 ms | 75,630 |
| Full CopilotKit standard, 69 components | 25/25 | 1,231–1,335 ms | 77,834 |
| Full OpenBot plus explicit no-match, descriptions repeated | 25/25 | 1,183–1,339 ms | 76,268 |
| Full OpenBot plus explicit no-match, descriptions shared once | 25/25 | 649–846 ms | 13,684 |

All 24 shared cases passed in every condition, with confidence at or above the spike’s 0.70 threshold. The full OpenBot set chose its custom `Breakdown` for the editable budget. The full parent set chose `Map` for interactive pan and zoom. The API returned zero output tokens in all 15 successful calls. The documented limit is 255 options per choice question and a 262,144-token context for shared input plus all questions. [Decisions API limits](https://aistudio.google.com/docs/decisions-api#limits)

**Confidence alone gave false positives.** With only the real components offered, the model was forced to pick one. For an editable formula spreadsheet, it chose `Table` at **0.917** on OpenBot’s full set and **0.951** on the parent set. Both exceeded 0.70. The shortlist also produced two unsupported picks above threshold. Adding `no_match` led to the correct refusal for all four unsupported OpenBot requests in every repeat. With repeated criteria, one refusal was below 0.70 and would still be rejected by the threshold. With shared descriptions, all four refusals exceeded 0.70.

The shared form sends the descriptions in the request’s shared input and keeps each question’s candidate keys as the typed decision options. It used **13,684 vs. 76,268 input tokens** for the same candidate set, and median client batch time was **773 vs. 1,244 ms**. These measurements reflect batches of 29 questions and include network time. They do not measure rendering, isolated model compute, or a single-slot request. The total estimated cost for the 15 calls at the documented paid input rate is about **$0.076**. [Decision pricing](https://aistudio.google.com/docs/pricing#gemini-decision)

## What this supports

For a bounded slot where the application already knows what job the component must do, the full catalog is a viable candidate set. Start with shared catalog descriptions and explicit no-match handling. Apply deterministic constraints for legal parent/child combinations, required props and capabilities the application excludes. Use smaller lists when the slot already narrows the legal components. This test covered single choices over authored slot descriptions. It did not assess model-generated slot decomposition, arbitrary component combinations, or the correctness of a complete rendered canvas. The labels and shortlists were authored for this spike.

## Reproduce

From the `decision-a2ui` directory after `npm ci`:

```sh
node openbot-options/bench.ts --check
node openbot-options/bench.ts --runs=3
node openbot-options/bench.ts --runs=3 --shared-only
```

Set `GEMINI_API_KEY` or `GOOGLE_API_KEY` for the two live commands. To recapture the catalog from the matching OpenBot checkout with installed dependencies, run `sh openbot-options/export-catalog.sh /path/to/canvas-spike`. The script prints only the catalog identifiers, counts and component descriptions.

[Cases and expected outcomes](cases.ts) · [Runnable benchmark](bench.ts) · [Individual results and confidences](results.ndjson)
