import { GlobalRegistrator } from "@happy-dom/global-registrator";

/*
 * React decides once, the first time it is evaluated, whether `CompositionEvent` exists.
 * The shared preload cannot be that time: a window that is then taken away leaves later
 * screens unable to finish a navigation. This file is the preload for one child process,
 * `composer-ime-enter.test.tsx` with OPENBOT_IME_REACT=1, and the window stays up.
 *
 * `queueMicrotask` and `setTimeout` are read once too. happy-dom's copies die with the
 * window, so the platform ones are put back before React reads them.
 */
const queueMicrotask = globalThis.queueMicrotask;
const setTimeout = globalThis.setTimeout;
const clearTimeout = globalThis.clearTimeout;
GlobalRegistrator.register({ url: "http://localhost/" });
globalThis.queueMicrotask = queueMicrotask;
globalThis.setTimeout = setTimeout;
globalThis.clearTimeout = clearTimeout;
await import("react-dom/client");
