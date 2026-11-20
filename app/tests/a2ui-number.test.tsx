import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { OPENBOT_UI } from "@/lib/copilot/a2ui";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const definition = OPENBOT_UI.components.get("TextField");
if (!definition) throw new Error("Missing TextField");
const Field = definition.component;
function Budget() {
  const [lodging, setLodging] = useState<unknown>(200);
  return (
    <>
      <Field
        label="Lodging"
        variant="number"
        value={lodging}
        setValue={setLodging}
      />
      <output>{String(100 + (lodging as number) + 80)}</output>
    </>
  );
}
test("editing a generated numeric field adds numbers instead of joining text", async () => {
  const view = render(<Budget />);
  expect(view.getByRole("status").textContent).toBe("380");
  const user = userEvent.setup({ document: window.document });
  await user.click(view.getByRole("spinbutton"));
  await user.keyboard("{Control>}a{/Control}{Backspace}");
  expect(view.getByRole("status").textContent).toBe("180");
  expect((view.getByRole("spinbutton") as HTMLInputElement).value).toBe("");
  await user.type(view.getByRole("spinbutton"), "250");
  expect(view.getByRole("status").textContent).toBe("430");
  await user.type(view.getByRole("spinbutton"), ".5");
  expect(view.getByRole("status").textContent).toBe("430.5");
});

for (const variant of ["shortText", undefined] as const) {
  test(`text field ${variant ?? "default"} preserves leading zeros`, async () => {
    let stored: unknown;
    function Text() {
      const [value, setValue] = useState<unknown>("");
      return (
        <Field
          label="ZIP"
          variant={variant}
          value={value}
          setValue={(next: unknown) => {
            stored = next;
            setValue(next);
          }}
        />
      );
    }
    const view = render(<Text />);
    const user = userEvent.setup({ document: window.document });
    await user.type(view.getByRole("textbox"), "007");
    expect(stored).toBe("007");
  });
}

test("an external value change resets the cleared field's local blank display", async () => {
  function Resettable() {
    const [value, setValue] = useState<unknown>(200);
    return (
      <>
        <Field
          label="Amount"
          variant="number"
          value={value}
          setValue={setValue}
        />
        <button type="button" onClick={() => setValue(7)}>
          Seven
        </button>
        <button type="button" onClick={() => setValue(0)}>
          Zero
        </button>
      </>
    );
  }
  const view = render(<Resettable />);
  const user = userEvent.setup({ document: window.document });
  const field = view.getByRole("spinbutton") as HTMLInputElement;
  await user.click(field);
  await user.keyboard("{Control>}a{/Control}{Backspace}");
  expect(field.value).toBe("");
  await user.click(view.getByText("Seven"));
  expect(field.value).toBe("7");
  await user.click(view.getByText("Zero"));
  expect(field.value).toBe("0");
});
