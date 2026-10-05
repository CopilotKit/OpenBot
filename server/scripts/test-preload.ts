/**
 * Loaded before any test file, to make module loading deterministic.
 *
 * Deep inside the runtime's dependencies, `@modelcontextprotocol/sdk`
 * does `require("eventsource")` from CommonJS, and eventsource ships as ESM only. Bun permits that
 * only when the module has already been evaluated as ESM by something earlier in the process, so
 * whether it works depends on the order the test files happen to be walked, an order that changes
 * whenever a test file is added or renamed.
 *
 * The failure is not a failing test. The file throws while being imported, so its tests are never
 * registered and never reported.
 *
 * Importing it here evaluates it as ESM once, before anything requires it, so the order no longer
 * decides the outcome. `eventsource` is declared as a dev dependency of this package for the same
 * reason; test determinism depends on it.
 *
 * This compatibility shim is narrow enough to delete when the SDK ships an ESM-safe require or Bun
 * handles it.
 *
 * `@copilotkit/runtime` also eagerly imports the Vertex provider, which pulls `gaxios` through a
 * Bun global cache path during tests. These tests do not exercise Vertex, so the provider is stubbed
 * at the same preload boundary and fails loudly if a server test tries to use it.
 */

import { mock } from "bun:test";
import "eventsource";

mock.module("@ai-sdk/google-vertex", () => ({
  createVertex: () => () => {
    throw new Error(
      "@ai-sdk/google-vertex is not available in Bun server tests",
    );
  },
}));
