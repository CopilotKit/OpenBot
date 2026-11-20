/**
 * JSON imported the way the shared modules import it: `import spec from "./model-providers.json"`.
 *
 * shared/model-providers.ts is the one rule every Bot in the box decides by (which provider, which
 * model, which OpenAI API), and this engine imports it rather than keeping a copy that could drift.
 * Bun and the bundlers that load it elsewhere take a JSON import as it is written. Node asks for an
 * import attribute (`with { type: "json" }`) and refuses the module without one. This resolve hook
 * gives every `.json` import the attribute Node asks for, so the shared module loads unchanged.
 *
 * It has to be registered before Node resolves anything that reaches shared/model-providers.ts, and
 * a static import is resolved before any module body runs. So src/main.ts imports this, then the
 * engine dynamically; the tests load it with `node --import` (package.json). Synchronous hooks
 * (`module.registerHooks`, Node 22.15+) apply to every import resolved after they are registered.
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (!resolved.url.endsWith(".json")) return resolved;
    return {
      ...resolved,
      format: "json",
      importAttributes: { ...context.importAttributes, type: "json" },
    };
  },
});
