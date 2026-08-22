import type { RuntimeModel } from "../copilot";

/**
 * The one model call the router makes, kept apart from the routing logic so that logic stays a pure
 * function the tests drive without a network. This reuses the deployment's own model and key — the
 * same ones the built-in coworkers answer on — so a router is never a second thing to configure.
 *
 * It throws on a missing key or a bad response on purpose: the router treats a throw as "not sure"
 * and lands on the default, so failure here is a soft landing, not an error a person sees.
 */
export function createModelCompleter(deps: {
  model: RuntimeModel;
  resolveApiKey: () => Promise<string | null>;
}): (prompt: string) => Promise<string> {
  return async (prompt: string) => {
    const key = await deps.resolveApiKey();
    if (!key) throw new Error("no model key");
    const base =
      process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com";
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: deps.model.defaultModel,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`router model answered ${response.status}`);
    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string")
      throw new Error("router model returned no text");
    return content;
  };
}
