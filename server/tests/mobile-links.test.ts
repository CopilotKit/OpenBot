import { expect, test } from "bun:test";
import { notificationDestination } from "../../mobile/src/links";

test("native push opens only known screens and preserves canonical owner-scoped conversation IDs", () => {
  expect(
    notificationDestination({
      url: "openbotmobile://conversation?channelId=channel",
    }),
  ).toEqual({ pathname: "/conversation", params: { channelId: "channel" } });
  expect(
    notificationDestination({
      url: "openbotmobile://approvals?channelId=channel&requestId=q1",
    }),
  ).toEqual({
    pathname: "/approvals",
    params: { channelId: "channel", requestId: "q1" },
  });
  for (const url of [
    "https://evil.test",
    "openbotmobile://attacker?channelId=c",
    "openbotmobile://conversation/evil?channelId=c",
    "openbotmobile://conversation",
    "openbotmobile://user:password@conversation?channelId=c",
  ])
    expect(notificationDestination({ url })).toBeNull();
});

test("a ping opens the Needs you list, and a malformed Needs you link opens nothing", () => {
  expect(notificationDestination({ url: "openbotmobile://needs-you" })).toEqual(
    { pathname: "/needs-you", params: {} },
  );
  for (const url of [
    "openbotmobile://needs-you/evil",
    "openbotmobile://needs-you?channelId=c",
    "openbotmobile://needs-you#top",
    "openbotmobile://user:password@needs-you",
    "openbotmobile://needs-you:8080",
    "https://needs-you",
    "openbotmobile://needs-yours",
  ])
    expect(notificationDestination({ url })).toBeNull();
});
