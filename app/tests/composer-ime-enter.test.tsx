// app/tests/composer-ime-enter.test.tsx
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Composer } from "../src/components/channels/composer/composer";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
beforeEach(() => {
  // The composer's dictation hook asks the server what this OpenBot can do; the
  // answer does not matter here, only that the query resolves.
  global.fetch = Object.assign(async () => Response.json({}), {
    preconnect: originalFetch.preconnect,
  });
});
afterEach(() => {
  global.fetch = originalFetch;
});

function draw() {
  const onSubmit = mock(() => {});
  const view = render(<Composer initialValue="hello" onSubmit={onSubmit} />);
  return {
    // `screen` binds to document.body when its module is first evaluated, which
    // is before this file registers happy-dom, so queries come from the render.
    editor: view.getByRole("textbox", { name: "Message" }),
    onSubmit,
  };
}

describe("Composer IME Enter", () => {
  test("a WebKit composition-confirming Enter (keyCode 229) does not send", () => {
    const { editor, onSubmit } = draw();
    // WebKit sends the confirming keydown after compositionend, where
    // isComposing is already false and only keyCode 229 identifies it.
    fireEvent.keyDown(editor, { key: "Enter", keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("a Chromium composing Enter (isComposing) does not send", () => {
    const { editor, onSubmit } = draw();
    fireEvent.keyDown(editor, { key: "Enter", keyCode: 13, isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("a plain Enter still sends", () => {
    const { editor, onSubmit } = draw();
    fireEvent.keyDown(editor, { key: "Enter", keyCode: 13 });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test("Shift+Enter still does not send", () => {
    const { editor, onSubmit } = draw();
    fireEvent.keyDown(editor, { key: "Enter", keyCode: 13, shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
