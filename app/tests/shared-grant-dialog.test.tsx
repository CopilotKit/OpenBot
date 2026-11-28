import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  SharedApprovalFields,
  sharedSectionSentence,
} from "../src/components/plugins/shared-approval-fields";
import type { SharedUseApproval } from "../src/lib/plugins/shared-use";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

describe("sharedSectionSentence", () => {
  test("says what a shared write and a shared read let people do", () => {
    expect(sharedSectionSentence("write", true)).toBe(
      "Anyone who can use this Bot can do this as the shared account.",
    );
    expect(sharedSectionSentence("read", true)).toBe(
      "Anyone who can use this Bot can read what this account can read.",
    );
    expect(sharedSectionSentence("write", false)).toBeNull();
  });
});

describe("SharedApprovalFields", () => {
  test("starts at the Bot's exposure and can be narrowed to its owner", async () => {
    let seen = null as SharedUseApproval | null;
    function Harness() {
      const [value, setValue] = useState<SharedUseApproval>({
        audience: "team",
        outsideInput: true,
        members: [],
      });
      seen = value;
      return <SharedApprovalFields onChange={setValue} value={value} />;
    }
    const view = render(<Harness />);
    expect(
      (view.getByRole("radio", { name: "Everyone" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    await userEvent.click(view.getByRole("radio", { name: "Only its owner" }));
    await userEvent.click(
      view.getByRole("checkbox", {
        name: "Messages from outside (email, Slack, webhooks) can use it",
      }),
    );
    expect(seen).toEqual({
      audience: "owner",
      outsideInput: false,
      members: [],
    });
  });

  test("offers named teams beside its owner and everyone, with no field to type a person into", () => {
    const view = render(
      <SharedApprovalFields
        onChange={() => {}}
        value={{ audience: "owner", outsideInput: false, members: [] }}
      />,
    );
    // Teams are picked from the organization's (team-grants-shared-account.test.tsx); people are
    // only ever the ones the Bot's audience already names.
    expect(
      (
        view.getByRole("radio", {
          name: "Named teams and people",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(view.queryByRole("textbox")).toBeNull();
  });
});
