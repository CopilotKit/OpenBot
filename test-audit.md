# OpenBot test audit

Base: `origin/main` at `c19d0653`. Branch: `codex/openbot-test-audit`.

## Criteria and scope

Reviewed the original 811 test-bearing files: 740 TypeScript/TSX files, 39 Python files, and 32 Rust modules. The review checked whether each case exercises a meaningful OpenBot user behavior, whether its assertions establish its stated claim, and whether a relevant defect can make it fail. Larger suites were read as compact callback bodies, with shared fixtures, helpers and implementation expanded where needed. Compile-time type contracts, executable configuration contracts, dependency-boundary mocks and opt-in live tests were retained where they protect product behavior.

Removed source-spelling and test-roster guards, tests of test-only infrastructure, tautologies, and claims unsupported by the fixtures or assertions. Infrastructure tests were removed for the requested end-user scope; they were not all incapable of failing. No production behavior was changed.

## Confirmed false positives

Each temporary production mutation below left the selected original test passing. All mutations were restored before editing tests.

| Claimed protection | Mutation that survived |
| --- | --- |
| PKCE S256 challenge | Return the constant `"x"` instead of the SHA-256 digest. |
| People page-size cap | Remove the `MAX_PAGE` clamp. The fixture had only three people. |
| Literal wildcard search | Remove `escapeLike`. The fixture had no competing wildcard match. |
| Component data-query bounds | Return the parsed argument without min/max clamping. Assertions checked only that a result existed. |
| Complete Arcade connection listing | Stop after the first page. The test asked only about the first connection. |

The desktop stop-profile test also searched its own file for a string already present inside its assertion, so removing the production command could not make it fail.

## Removals

Removed 169 source test declarations across 76 test files, including two unreachable placeholder declarations. Deleted 21 whole test files and one unused test helper. Retained the CrewAI deployment-configuration test with a corrected title.

Counts below are source test declarations, before table/loop expansion. The deleted source-scanner helper has no test declarations.

| File | Removed declarations | Reason |
| --- | ---: | --- |
| `agent-adk/tests/test_model_spec.py` | 1 | Source spelling checks do not execute bot configuration; dead references satisfy assertions. |
| `agent-ag2/tests/test_model_spec.py` | 1 | Source spelling checks do not execute bot configuration; dead references satisfy assertions. |
| `agent-agno/tests/test_model_spec.py` | 1 | Source spelling checks do not execute bot configuration; dead references satisfy assertions. |
| `agent-antigravity/tests/test_model_spec.py` | 2 | Source spelling checks do not execute bot configuration; dead references satisfy assertions. |
| `agent-computer/tests/aria-snapshot.test.ts` | 2 | Fixture-only YAML parsing never calls production parser |
| `agent-computer/tests/viewer.test.ts` | 2 | No launch exception or during-teardown observation; adjacent real lifecycle tests retained |
| `agent-crewai/tests/test_model_spec.py` | 1 | Source spelling checks do not execute bot configuration; dead references satisfy assertions. |
| `agent-crewai/tests/test_token_restoration.py` | 1 | Exercises teardown of another pytest test, not shipped bot behavior (six parameter combinations). |
| `agent-langgraph-agui/tests/test_model_spec.py` | 1 | Source spelling checks do not execute bot configuration; dead references satisfy assertions. |
| `agent-langroid/tests/test_model_spec.py` | 1 | Source spelling checks do not execute bot configuration; dead references satisfy assertions. |
| `agent-llamaindex/tests/test_model_spec.py` | 1 | Source spelling checks do not execute bot configuration; dead references satisfy assertions. |
| `agent-microsoft/tests/test_model_spec.py` | 1 | Source spelling checks do not execute bot configuration; dead references satisfy assertions. |
| `agent-pydantic-ai/tests/test_model_spec.py` | 1 | Source spelling checks do not execute bot configuration; dead references satisfy assertions. |
| `agent-strands/tests/test_model_spec.py` | 1 | Source spelling checks do not execute bot configuration; dead references satisfy assertions. |
| `app/tests/admin-plugins-vocabulary-wiring.test.ts` | 3 | Only scans route-source spellings. A function name in dead code satisfies the positive check; indirect vendor text/navigation avoids the negative regex. Does not render either provider or exercise routing. Real provider UI coverage remains in admin-brokered-row-provider, arcade-directory-screen and connected-account tests. |
| `app/tests/arcade-no-browser-calls.test.ts` | 1 | Only regex-scans source strings (including comments); cannot observe browser network calls and can pass when host/path is assembled at runtime. No actual browser request or import graph is exercised. |
| `app/tests/composer-queue-attachments.test.tsx` | 1 | Retain attachment queue, failure restoration, cap, removal, and lifecycle behaviors. Selected test asserts identities collected by its own useCallback wrappers (handedOut sets), testing the measuring harness rather than a user-visible application outcome. |
| `app/tests/form-submit-controls.test.ts` | 1 | Source AST presence scan never renders/clicks controls. Any JSX component with type="submit" counts even if it ignores the prop or is disabled; handlers and actual submitted payloads are never exercised. Claim can pass for inert forms. |
| `app/tests/plugin-mutation-refresh.test.ts` | 2 | Retain mutation execution tests observing refused-write invalidation, actual hostile-ID URLs and consent return targets. Remove URL source regex and exported-factory test-roster bookkeeping; neither executes the behavior it is intended to guarantee. |
| `app/tests/search-text.test.ts` | 1 | Retain real searchText, searchTextEntry and parseSearchText URL round trips. Remove final source regex guard; aliasing search or using another conditional spelling evades it without preserving the URL value. |
| `app/tests/theme-preference.test.ts` | 4 | Retain parseStoredDarkTheme/applyDarkTheme behavior and actual stylesheet color-scheme declarations. Four pre-paint tests only find text/script tag attributes: an inert inline script plus comments or unreachable theme code passes all checks without applying a theme. |
| `app/tests/transcript-attachments.test.tsx` | 1 | Retain rendering, missing-attachment, lightbox, queue, MIME and comparator behavior tests. Selected assertion checks React.memo internal .compare identity without a rerender or observable preservation/performance outcome; it couples to implementation wiring. |
| `bunfig.toml` | 0 | Removed the stale comment reference to the deleted test-preload guard; preload configuration is unchanged. |
| `desktop/src-tauri/src/engine.rs` | 1 | Constructs EngineStatus locally with engine=None and responding=false, then asserts those exact fields. No detect or transformation invocation; setup forces success. |
| `desktop/src-tauri/src/main.rs` | 2 | Source-text self-scans: one checks another test source for call spelling; the other splits the first handler macro source and searches names. Neither invokes production behavior or IPC registration. Source-scans another test body for ask_the_bot( and never executes production transport or vault access. Tests test-authoring style, not end-user behavior. Source-splits text following generate_handler! and searches for two command-name spellings. Never attempts IPC or inspects compiled handler behavior, so syntactic registration refactors or another dispatch path evade it. |
| `desktop/src-tauri/src/plan.rs` | 1 | Only scans CHATGPT_LOGIN source for json.dumps(raw and absence of the retired marker. Does not execute the login program or inspect printed credentials; commented/dead print satisfies the claimed behavior. |
| `desktop/src-tauri/src/stack.rs` | 1 | Reads its own entire source and searches for .args([...harness, down]); that literal occurs in the test needle itself. Production command can disappear without failure, and Stop is never invoked. Reads its own entire source with include_str!("stack.rs") and searches for a literal .args([..."harness", "down"]) which already occurs inside that assertion’s raw-string needle. Even deleting the production stop command leaves the test green. It never invokes Stop. |
| `desktop/src-tauri/src/test_support.rs` | 2 | Executes only test-support utilities: scratch path uniqueness and compilation/execution of a synthetic fixture. No shipped end-user behavior. Helper implementations are preserved. Only tests test-only support utilities: scratch path uniqueness and compiling/running a synthetic fixture. Neither exercises shipped application behavior. Preserve helper functions and actual application tests using them. |
| `scripts/mutation-register.test.ts` | 7 | Only checks the mutation-runner register, source anchors, fixture transformations and test-file existence; does not run product mutations or user behavior. |
| `scripts/test-ci.test.ts` | 1 | Exercises test-runner log plumbing using a synthetic failed child; no shipped OpenBot use case. |
| `server/tests/agent-escalation.test.ts` | 2 | Default-person claim checks only undefined optional initiator on fake audit recorder. No row existence assertion and no real audit defaulting runs. Also remove tool-name equality: constructs escalationTool and compares name to its exported constant, without offering a tool to any run or evaluating grants. |
| `server/tests/agent-handoff.test.ts` | 1 | Default-person claim checks only undefined optional initiator on fake audit recorder. No row existence assertion and no real audit defaulting runs. |
| `server/tests/agent-profile-policy.test.ts` | 1 | Keep actual access/run/manage permission scenarios; function identity equality merely pins alias implementation already behaviorally covered. |
| `server/tests/arcade-attempt-schema.test.ts` | 3 | Three scenarios execute test-local claim SQL duplicating the application upsert, expiration, and completed-at logic; they do not call production claimAuthorizationAttempt. Production store integration covers these cases. |
| `server/tests/arcade-live.test.ts` | 1 | Preserve opt-in vendor scenarios. Diagnostic print test calls local say and only checks test PORT is integer, proving neither output nor ordering and exercising no production. |
| `server/tests/arcade-pagination-engine.test.ts` | 1 | Pagination and truncation behavior exercised through real SDK/server, except one first-page positive test that claims a whole-list read and survives stopping at first page. |
| `server/tests/arcade-transport-registry.test.ts` | 1 | Keep transport lookup and top-level compile-time contracts; runtime literal test merely compares test-local assignments with the same literals. |
| `server/tests/arcade-vendor-read-contract.test.ts` | 4 | Keep vendor-field behavioral matrix via real broker/transport. Binding-name source regex only checks code presence; two debt-list checks operate solely on the file-local empty KNOWN_FAIL_OPEN object and always pass for current setup. Local ROWS key uniqueness is test-fixture bookkeeping without production behavior. |
| `server/tests/arcade-verifier-notice.test.ts` | 2 | Keep notice function behavior; remove source-string checks posing as mounted-route/startup execution coverage. |
| `server/tests/assertion-shape.test.ts` | 9 | Only enforces test-authoring/source-spelling conventions and tests the local scanner using synthetic source snippets; no executed end-user product behavior. These are lint/architecture guards, outside the requested user-use-case test criterion. |
| `server/tests/attachment-routes.test.ts` | 1 | Retain real HTTP/database upload, download, membership, draft privacy, concurrency, size, header and send-stamp behaviors. Remove local test-helper diagnostic: it calls only waitForBlockedSession defined in this same test file and compares its testing timeout constants, with no shipped behavior exercised. |
| `server/tests/audit.test.ts` | 2 | Keep redaction and admin API behavior. String occurrence does not prove event emission; SQL-chain text does not prove effective database trigger behavior (covered by real retention integration). |
| `server/tests/broker-authorization-pairing.test.ts` | 3 | Source regex parses broker/stub object literals and source coverage counts; never executes production authorization or callback pairing. |
| `server/tests/broker-stub-ratchet.test.ts` | 6 | Only enforces test-authoring/source-spelling conventions and tests the local scanner using synthetic source snippets; no executed end-user product behavior. These are lint/architecture guards, outside the requested user-use-case test criterion. |
| `server/tests/brokered-provenance.test.ts` | 2 | Only enforces test-authoring/source-spelling conventions and tests the local scanner using synthetic source snippets; no executed end-user product behavior. These are lint/architecture guards, outside the requested user-use-case test criterion. |
| `server/tests/bunfig-preload.test.ts` | 2 | Only validates the test runner preload configuration and script existence, with no shipped end-user behavior. Root final consistency review: verifies Bun preload settings for test execution only; no end-user product behavior. Configuration implementation remains unchanged. |
| `server/tests/channel-activity.integration.test.ts` | 1 | Retain real persistent pagination, ties, channel integrity, membership, recency, pins and direct-conversation races. Remove maximum-page test: seeds only one channel, requests100000, asserts<=200, so uncapped production query still satisfies it. |
| `server/tests/component-store.integration.test.ts` | 1 | Only asserts defined results with no row-content or limit assertions; removing bounded argument caps still passes (mutation verified). Actual access/grant HTTP flows, database state, publication decisions and component permissions. |
| `server/tests/composio-adapter.test.ts` | 1 | Enumerates adapter method names and compares them with the test table, then checks non-method member names. It asserts test coverage bookkeeping and API shape without invoking any adapter behavior. Runtime vendor-failure table cases are retained. |
| `server/tests/composio-broker-seam.test.ts` | 1 | Keep real broker return-URL/error formatting and declared authorization capabilities. Remove action-ignored claim: empty auth-config listing forces independent refusal, all errors become strings, and the sole assertion accepts any message lacking action; a successful authorization path is never exercised. |
| `server/tests/composio-connection-kinds.test.ts` | 5 | Actual scheme classification and all36 named consumer/probe callbacks are meaningful. Remove only3test-table bookkeeping checks and2unreachable declared-only callbacks, plus dead scaffolding. |
| `server/tests/composio-connections.test.ts` | 1 | Actual store/database connection lifecycle, probes, gates, audit, idempotency, duplicate rows and failures. Remove local cleanup-helper test only. |
| `server/tests/composio-grants-for.test.ts` | 1 | Keep real broker grant tests and required-field compile-time contract; flow test only constructs local typed object and calls hardcoded local functions. |
| `server/tests/computer-client.test.ts` | 2 | Real request/download/error/abort behavior; two signal-presence-only claims removed. Both claim request timeout behavior but only assert presence of a signal: first uses toBeDefined; second converts signals to 1/0 and expects [1,1]. An AbortController signal that never aborts passes both. Neither tests timeout expiration or the 45s versus 615s deadline distinction. Retain neighboring delayed-fetch test that actually verifies default timeout and override. |
| `server/tests/connector-tokens-never-reach-computer.test.ts` | 1 | Keep executed supervisor environmentFor secret filtering; import-pattern scan is a source architecture rule and does not test token delivery. |
| `server/tests/control-refusal-end-to-end.test.ts` | 1 | Keep real HTTP refusal propagation tests. Remove audit count-only test: gateway writes an allowed decision before executing; rows.length>0 still passes with failure/refusal audit removed. |
| `server/tests/cull-sweep-wiring.test.ts` | 2 | Both tests grep script source for literal option strings. Neither invokes the sweep or checks purge arguments or retention. |
| `server/tests/database.test.ts` | 1 | Only asserts database.query.users property exists; performs no database operation and never proves the claimed absence of a query. Shallow shape smoke without end-user behavior. |
| `server/tests/fixture-identity-distinct.test.ts` | 6 | Only enforces test-authoring/source-spelling conventions and tests the local scanner using synthetic source snippets; no executed end-user product behavior. These are lint/architecture guards, outside the requested user-use-case test criterion. |
| `server/tests/jsonb-encoding.integration.test.ts` | 1 | Retain actual schema and audit-store writes read through SQL JSON operators. Remove ambient whole-trail count test: no malformed historical fixture is seeded and no migration/repair is invoked, so an empty/clean database passes independently of the alleged repair behavior. |
| `server/tests/mastra-roster.test.ts` | 1 | Keep production roster selection and duplication cases. Token test only builds test-local managedAgent/ourEndpoints and compares strings, never invokes isManagedEndpoint or createRuntimeAgentLoader and never checks a token header. |
| `server/tests/migration-journal.test.ts` | 5 | Keep actual journal/snapshot artifact consistency checks; remove five self-tests of test-local SQL/journal scanners on synthetic fixtures. |
| `server/tests/pending-authorization-audit-ledger.test.ts` | 12 | Entire file inventories source syntax, hardcoded dispositions and waiver/debt metadata. Event proximity/name checks do not execute or verify audit firing; dead/unreachable event code satisfies the check. |
| `server/tests/people-paging.integration.test.ts` | 2 | Wildcard fixture has no alternate-character match: unescaped _ Percent still matches exactly one seeded person. Page-ceiling fixture seeds only three rows then asserts <=200, so removing the 200-row cap passes. |
| `server/tests/plugin-oauth.test.ts` | 1 | Claims S256 but asserts only differs from input, URL-safe characters and repeatability. A constant URL-safe string passes; no known SHA256 vector or independently computed expected digest. |
| `server/tests/plugin-store.integration.test.ts` | 1 | Reads plugin store sources, rejects literal error.message and requires sanitizer name somewhere. Renaming caught variable or inserting unused sanitizer reference bypasses claimed confidentiality protection. Behavioral sanitization tests in the same file are retained. |
| `server/tests/shared-use-arcade-urls.test.ts` | 1 | Neither seed nor test files an approval. Both server-row lookups return null, so equality passes even if approval canonicalization is broken. |
| `server/tests/sole-definition.test.ts` | 5 | Entire file counts source definitions/literal spellings against hardcoded known-debt entries and tests its scanner. It does not exercise end-user behavior; even recorded duplicate definitions are accepted. |
| `server/tests/store-scheme-sites.test.ts` | 1 | Reads shared-use-store.ts as text, requires BROKERED_PROFILE[provider].scheme and forbids a template spelling. Unused or wrong-branch reference passes without testing provider dispatch. |
| `server/tests/support/database.test.ts` | 4 | Tests testDatabaseUrlFrom test-only safety helper; no product use case or production code is exercised. |
| `server/tests/support/source-scan.test.ts` | 9 | All nine cases exercise only test-support source scanning and fixture enumeration/comment stripping. Real helper coverage, but no shipped end-user behavior. |
| `server/tests/support/source-scan.ts` | 0 | Unused test-only scanner after removing every consumer. |
| `server/tests/tenant-package.test.ts` | 1 | Calls validateTenantPackage and compares parsed skills arrays only. Never invokes loadTenantPackage, whose checksum code is separate; omitting skills from the checksum leaves this green. |
| `server/tests/test-network-guard.test.ts` | 8 | Exercises only the test-only network guard and its loopback/SDK allowances; the network guard implementation remains installed, but its own tests do not exercise shipped OpenBot user behavior. |
| `server/tests/ts-expect-error-coverage.test.ts` | 2 | Only checks test authoring/compiler inclusion convention and validates its own directive regex. No shipped application behavior. |
| `shared/harnesses.test.ts` | 0 | Preserved meaningful CrewAI deployment configuration assertions; narrowed the test title to the image, health endpoint and port it actually checks. |
| `tests/clean-checkout.test.ts` | 2 | Dependency whitelist never resolves imports; ignore-source text does not prove effective Git ignore rules |
| `tests/compose.test.ts` | 1 | Global Compose string occurrences do not verify migration dependency health ordering |
| `tests/workspace.test.ts` | 1 | Only greps shell source; never starts the worker |

## Validation

| Check | Result |
| --- | --- |
| Server, 20 sequential shards against a migrated disposable PostgreSQL database | 5,657 passed; 0 failed; 18 opt-in skipped |
| App tests, including colocated source tests | 1,668 passed; 0 failed |
| Five desktop TypeScript suites | 171 passed; 0 failed |
| Other Bun suites, 94 files in sequential batches of at most 20 | 857 passed; 0 failed; 61 opt-in skipped |
| Restored shared harness configuration suite, checked after final review | 9 passed; 0 failed; includes one restored case absent from the preceding batched run |
| Eleven edited Python model-spec suites, isolated pytest invocations | 33 passed; 0 failed |
| All 38 remaining Python test files | AST parsing passed |
| Forty edited TypeScript/TSX files | Biome lint and formatting passed |
| Git diff whitespace validation | Passed |
| Server test typecheck | Passed against the existing 240-error baseline; no new errors |

Server command: `TEST_DATABASE_URL=... DATABASE_URL=... SHARD_SIZE=20 bun run test:server:sharded`. App command: `bun test ./app/tests ./app/src`. Test types: `bun run typecheck:tests`.

Memory was monitored throughout. Resource-heavy test runs were serialized, Bun harness tests were batched, and the disposable database was limited to 512 MiB and one CPU. Reported system-wide free memory stayed around 35–43% during final verification.

## Limits

This was a static semantic audit plus selected mutation checks, not exhaustive mutation testing of every retained case. Live vendor/browser/deployment suites remain opt-in and were not exercised. The unchanged Python framework integration suites were reviewed but not executed; the edited model-spec suites were executed. Rust tests were reviewed but could not be compiled or run because Cargo is not installed. Local Bun is 1.4.2; the repository pins 1.4.3. The server test typecheck uses its existing baseline of 240 known errors, rather than asserting the entire test tree is type-error-free.
