import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import {
  LateRenderersWatch,
  useLateRenderers,
} from "@/components/channels/late-renderers";
import { settleReactWork } from "./settle-react-work";

/**
 * The SDK swaps its list of activity renderers in an effect when generative UI turns on (the
 * capabilities answer, or the runtime connecting) and tells nobody. An activity drawn before then
 * found no renderer and stayed blank until its message happened to change. It now looks again a
 * frame after either of those, and redraws when the list really did change.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function fakeCore() {
  const listeners = new Set<() => void>();
  return {
    renderActivityMessages: [] as unknown[],
    subscribe(subscriber: { onRuntimeConnectionStatusChanged?: () => void }) {
      const listener = subscriber.onRuntimeConnectionStatusChanged;
      if (listener) listeners.add(listener);
      return { unsubscribe: () => listener && listeners.delete(listener) };
    },
    connect() {
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

const nextFrame = () =>
  act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));

test("redraws once the renderers change after the runtime connects", async () => {
  const core = fakeCore();
  const { result } = renderHook(() => useLateRenderers(core, true, undefined));
  await nextFrame();
  const before = result.current;

  core.renderActivityMessages = [{ activityType: "a2ui" }];
  act(() => core.connect());
  await nextFrame();

  expect(result.current).toBe(before + 1);
});

test("redraws once the renderers change after the capabilities arrive", async () => {
  const core = fakeCore();
  const { result, rerender } = renderHook(
    ({ settled }: { settled: unknown }) =>
      useLateRenderers(core, true, settled),
    { initialProps: { settled: undefined as unknown } },
  );
  await nextFrame();
  const before = result.current;

  core.renderActivityMessages = [{ activityType: "a2ui" }];
  rerender({ settled: true });
  await nextFrame();

  expect(result.current).toBe(before + 1);
});

test("an activity that already has its renderer does not listen", () => {
  const core = fakeCore();
  renderHook(() => useLateRenderers(core, false, undefined));

  expect(core.listeners.size).toBe(0);
});

/*
 * The provider's swap can land a few frames after the connection is heard, under the load of a cold
 * start. One look a frame later missed it, and nothing looked again.
 */
test("keeps looking for a few frames after the runtime connects", async () => {
  const core = fakeCore();
  const { result } = renderHook(() => useLateRenderers(core, true, undefined));
  await nextFrame();
  const before = result.current;

  act(() => core.connect());
  await nextFrame();
  await nextFrame();
  core.renderActivityMessages = [{ activityType: "a2ui" }];
  await nextFrame();
  await nextFrame();

  expect(result.current).toBe(before + 1);
});

/* One subscription for the whole transcript, however many activities are waiting in it. */
test("the transcript's watch listens once and reports a change", async () => {
  const core = fakeCore();
  const versions: number[] = [];
  render(
    <LateRenderersWatch
      core={core}
      onVersion={(version) => versions.push(version)}
      settled={undefined}
    />,
  );
  expect(core.listeners.size).toBe(1);

  core.renderActivityMessages = [{ activityType: "a2ui" }];
  act(() => core.connect());
  await nextFrame();

  expect(versions).toEqual([1]);
});
