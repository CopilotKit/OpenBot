import { expect, test } from "bun:test";
import { firstConversationGreeting } from "../src/lib/auth/greeting";
import type { AuthenticatedUser } from "../src/lib/auth/queries";

const user: AuthenticatedUser = {
  id: "u",
  email: "user@example.test",
  name: "Sam Julien",
  role: "user",
  onboarding: null,
  needsName: false,
};
test("greets by the saved name only with a confirmed empty conversation list", () => {
  expect(firstConversationGreeting(user, true)).toBe(
    "Hi Sam Julien, what would you like to work on?",
  );
  expect(firstConversationGreeting(user, false)).toBe("Start a conversation");
});
test("does not greet with a missing or placeholder name", () => {
  for (const value of [
    undefined,
    null,
    { ...user, name: "" },
    { ...user, needsName: true },
    { ...user, name: user.email },
  ]) {
    expect(firstConversationGreeting(value, true)).toBe("Start a conversation");
  }
});
