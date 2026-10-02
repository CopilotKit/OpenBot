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
