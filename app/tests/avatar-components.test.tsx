import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { UserAvatar } from "@/components/people/user-avatar";
import { AvatarUploadActions } from "@/components/ui/avatar-upload-actions";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("an uploaded coworker image replaces the generated avatar", () => {
  const { getByRole } = render(
    <AbstractAvatar
      image="data:image/png;base64,chosen"
      name="Researcher"
      seed="researcher"
    />,
  );

  expect(
    getByRole("img", { name: "Researcher" }).querySelector("img")?.src,
  ).toBe("data:image/png;base64,chosen");
});

test("a person without an image gets readable initials", () => {
  const { getByRole } = render(
    <UserAvatar email="ninja@example.test" name="Ninja Builder" />,
  );

  expect(getByRole("img", { name: "Ninja Builder" }).textContent).toBe("NB");
});

test("only a custom image offers removal", () => {
  const { getByRole, queryByRole, rerender } = render(
    <AvatarUploadActions
      hasCustomImage={false}
      hasImage
      label="your avatar"
      onChange={async () => {}}
    />,
  );
  expect(queryByRole("button", { name: "Remove your avatar" })).toBeNull();

  rerender(
    <AvatarUploadActions
      hasCustomImage
      hasImage
      label="your avatar"
      onChange={async () => {}}
    />,
  );
  expect(getByRole("button", { name: "Remove your avatar" })).toBeTruthy();
});
