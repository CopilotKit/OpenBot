import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Enter confirms an IME candidate. It does not send the chat message.
 *
 * Zhuyin, and the other input methods, confirm the highlighted candidate with Enter. That key
 * still arrives as keydown Enter. Chromium marks it `isComposing`. WebKit sends it after
 * `compositionend` with key code 229. Some browsers deliver the keydown before `compositionend`
 * with `isComposing` false and key code 13, while the composition is still open. None of those
 * send. A later Enter, after `compositionend`, does. Shift+Enter still starts a new line.
 *
 * Both composer layouts are the same field. OpenBot Desktop shows this page, so it is the same
 * field there too.
 */

/**
 * The suite's React is evaluated with no `CompositionEvent`, so `compositionstart` never arrives
 * and key code 229 is treated as a composition that cannot end. A child process
 * (`ime-react-preload.ts`, `OPENBOT_IME_REACT=1`) evaluates React while happy-dom still has
 * `CompositionEvent`. The cases that need a composition to open and close run there.
 */
const compositionEvents = process.env.OPENBOT_IME_REACT === "1";
const whileOpen = compositionEvents ? test : test.skip;

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://localhost/" });
  }
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const DRAFT = "Draft";

function renderComposer(compact: boolean) {
  const sent: string[] = [];
  const view = render(
    <Composer
      compact={compact}
      initialValue={DRAFT}
      onSubmit={(draft) => {
        sent.push(draft.text);
      }}
    />,
  );
  const box = () => view.getByRole("textbox", { name: "Message" });
  return { box, sent };
}

async function ready(compact: boolean) {
  const rendered = renderComposer(compact);
  await waitFor(() => expect(rendered.box().textContent).toContain(DRAFT));
  return rendered;
}

for (const compact of [true, false]) {
  const layout = compact ? "compact" : "default";

  test(`${layout}: Enter sends a finished message`, async () => {
    const { box, sent } = await ready(compact);
    fireEvent.keyDown(box(), { key: "Enter", keyCode: 13 });
    await waitFor(() => expect(sent).toEqual([DRAFT]));
  });

  test(`${layout}: Shift+Enter does not send`, async () => {
    const { box, sent } = await ready(compact);
    const editor = box();
    editor.focus();
    const range = editor.ownerDocument.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = editor.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true, keyCode: 13 });
    expect(sent).toEqual([]);
    expect(editor.textContent).toContain(DRAFT);
    // The newline is a `<br>` at the caret. A contentEditable's textContent hides it.
    expect(editor.querySelector("br")).not.toBeNull();
  });

  test(`${layout}: Enter marked isComposing does not send`, async () => {
    const { box, sent } = await ready(compact);
    const text = box().textContent;
    expect(
      fireEvent.keyDown(box(), {
        key: "Enter",
        isComposing: true,
        keyCode: 13,
      }),
    ).toBe(true);
    expect(sent).toEqual([]);
    expect(box().textContent).toBe(text);

    fireEvent.compositionEnd(box());
    fireEvent.keyDown(box(), { key: "Enter", keyCode: 13 });
    await waitFor(() => expect(sent).toEqual([DRAFT]));
  });

  test(`${layout}: Enter with key code 229 does not send`, async () => {
    const { box, sent } = await ready(compact);
    const text = box().textContent;
    expect(
      fireEvent.keyDown(box(), {
        key: "Enter",
        keyCode: 229,
        isComposing: false,
      }),
    ).toBe(true);
    expect(sent).toEqual([]);
    expect(box().textContent).toBe(text);

    // Without CompositionEvent, React treats 229 as the start of a composition that never ends,
    // so the next Enter is not a fair check. The child process has CompositionEvent, and there
    // the next Enter sends.
    if (!compositionEvents) return;
    fireEvent.keyDown(box(), { key: "Enter", keyCode: 13 });
    await waitFor(() => expect(sent).toEqual([DRAFT]));
  });

  whileOpen(
    `${layout}: Enter before compositionend does not send`,
    async () => {
      const { box, sent } = await ready(compact);
      const text = box().textContent;
      fireEvent.compositionStart(box());
      // The keydown lands first, unmarked, while the composition is still open.
      expect(
        fireEvent.keyDown(box(), {
          key: "Enter",
          keyCode: 13,
          isComposing: false,
        }),
      ).toBe(true);
      expect(sent).toEqual([]);
      expect(box().textContent).toBe(text);

      fireEvent.compositionEnd(box());
      fireEvent.keyDown(box(), { key: "Enter", keyCode: 13 });
      await waitFor(() => expect(sent).toEqual([DRAFT]));
    },
  );
}

/** A finger is the only pointer, so Return does not send and Cmd+Enter does. */
function touchPointer() {
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query: string) => {
    const queryList = original(query);
    return new Proxy(queryList, {
      get(target, prop, receiver) {
        if (prop === "matches") return query === "(pointer: coarse)";
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return () => {
    window.matchMedia = original;
  };
}

test("touch: Cmd+Enter marked isComposing does not send", async () => {
  const restore = touchPointer();
  try {
    const { box, sent } = await ready(true);
    fireEvent.keyDown(box(), {
      key: "Enter",
      metaKey: true,
      keyCode: 13,
      isComposing: true,
    });
    expect(sent).toEqual([]);

    fireEvent.keyDown(box(), { key: "Enter", metaKey: true, keyCode: 13 });
    await waitFor(() => expect(sent).toEqual([DRAFT]));
  } finally {
    restore();
  }
});

whileOpen("touch: Cmd+Enter before compositionend does not send", async () => {
  const restore = touchPointer();
  try {
    const { box, sent } = await ready(true);
    fireEvent.compositionStart(box());
    fireEvent.keyDown(box(), {
      key: "Enter",
      metaKey: true,
      keyCode: 13,
      isComposing: false,
    });
    expect(sent).toEqual([]);

    fireEvent.compositionEnd(box());
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true, keyCode: 13 });
    await waitFor(() => expect(sent).toEqual([DRAFT]));
  } finally {
    restore();
  }
});

if (!compositionEvents) {
  test("a composition that opens and closes is checked where CompositionEvent exists", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "test",
        "--preload",
        "./app/tests/ime-react-preload.ts",
        "app/tests/composer-ime-enter.test.tsx",
      ],
      cwd: `${import.meta.dir}/../..`,
      env: { ...process.env, OPENBOT_IME_REACT: "1" },
      stderr: "pipe",
      stdout: "pipe",
    });
    if (result.exitCode !== 0) {
      const output = `${result.stdout}\n${result.stderr}`;
      throw new Error(output.slice(-6000));
    }
  }, 60_000);
}
