import { describe, expect, test } from "bun:test";
import { computerHostConfig } from "../src/docker";
import { namesFor } from "../src/names";

describe("managed computer host configuration", () => {
  test("passes validated static mappings to Docker", () => {
    const result = namesFor("erp-netsfera");
    if (!result.ok) throw new Error(result.reason);

    expect(
      computerHostConfig(result.names, {
        image: "openbot-agent-computer:test",
        environment: [],
        extraHosts: ["erp.netsfera.es:100.64.10.20"],
      }).ExtraHosts,
    ).toEqual(["erp.netsfera.es:100.64.10.20"]);
  });
});
