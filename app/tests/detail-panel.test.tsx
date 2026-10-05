import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { DetailPanel } from "@/components/layout/detail-panel";

class Observer implements ResizeObserver {
  static targets = new Map<Element, Observer>();
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    Observer.targets.set(target, this);
  }
  unobserve(target: Element) {
    Observer.targets.delete(target);
  }
  disconnect() {
    for (const [target, observer] of Observer.targets) {
      if (observer === this) Observer.targets.delete(target);
    }
  }
  resize(target: Element, width: number) {
    this.callback(
      [
        {
          target,
          contentRect: new DOMRect(0, 0, width, 640),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      this,
    );
  }
}
let originalObserver: typeof ResizeObserver;
beforeAll(() => {
  GlobalRegistrator.register();
  originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = Observer;
});
afterEach(() => {
  cleanup();
  Observer.targets.clear();
});
afterAll(() => {
  globalThis.ResizeObserver = originalObserver;
  GlobalRegistrator.unregister();
});

async function resize(container: HTMLElement, width: number) {
  const target = container.firstElementChild;
  if (!target) throw new Error("Panel root missing");
  await act(async () => {
    Observer.targets.get(target)?.resize(target, width);
  });
}

test("narrow container overlays details without remounting the chat draft", async () => {
  let mounts = 0;
  function Chat() {
    useEffect(() => {
      mounts += 1;
    }, []);
    return <textarea aria-label="Draft" defaultValue="Keep this draft" />;
  }
  const view = render(
    <DetailPanel
      open
      title="Computer"
      onClose={() => {}}
      detail={<p>Browser preview</p>}
    >
      <Chat />
    </DetailPanel>,
  );
  await resize(view.container, 560);
  expect(await view.findByRole("dialog", { name: "Computer" })).toBeTruthy();
  const draft = view.getByDisplayValue("Keep this draft");
  await resize(view.container, 1000);
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(view.getByText("Browser preview")).toBeTruthy();
  expect(view.getByDisplayValue("Keep this draft")).toBe(draft);
  await resize(view.container, 560);
  expect(await view.findByRole("dialog", { name: "Computer" })).toBeTruthy();
  expect(mounts).toBe(1);
});

test("closing narrow details invokes the owner and unmounts detail work", async () => {
  let closed = 0;
  const props = {
    title: "Computer",
    onClose: () => {
      closed += 1;
    },
    detail: <p>Browser preview</p>,
    children: <p>Chat</p>,
  };
  const view = render(<DetailPanel {...props} open />);
  await resize(view.container, 380);
  expect(await view.findByRole("dialog", { name: "Computer" })).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Close" }));
  expect(closed).toBe(1);
  view.rerender(<DetailPanel {...props} open={false} />);
  await waitFor(() => expect(view.queryByText("Browser preview")).toBeNull());
});
