/**
 * The most tools one request to a model may carry.
 *
 * MEASURED, NOT ASSUMED. OpenAI's Chat Completions API refuses a request with more
 * (`array_above_max_length`: "Expected an array with maximum length 128"), on every model tried
 * from `gpt-4.1` to `gpt-6.1-terra`. Its Responses API took 279 and 2,000 in the same test, and
 * refused a set of 279 for a different reason: function tools there are strict unless told
 * otherwise, and OpenAI caps the compiled size of all strict schemas in one request ("Compilation
 * limits apply to all strict schemas in the request"), which a hundred Composio-sized schemas
 * already approach. Anthropic documents no count for ordinary tools.
 *
 * So this is a hard limit on one API and a sensible ceiling on the others. A Bot may hold far more
 * than this; it is what one model step is sent that must stay under it, which is what tool search
 * (`server/src/agents/tool-search.ts`) arranges and the pre-flight count (`tool-limit.ts`) checks.
 */
export const MODEL_TOOL_LIMIT = 128;
