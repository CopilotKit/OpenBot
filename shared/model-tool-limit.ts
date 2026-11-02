/**
 * The most tools one request to a model may carry.
 *
 * OpenAI refuses a request with more (`array_above_max_length`: "Expected an array with maximum
 * length 128"), and a Bot whose every request is refused never answers anything. Every granted tool
 * goes to the model on every call, so this bounds what a Bot can hold, not only what one run uses.
 *
 * One number for every place that has to respect it: refusing an approval that would take a Bot past
 * it, and saying so when a Bot already is.
 */
export const MODEL_TOOL_LIMIT = 128;
