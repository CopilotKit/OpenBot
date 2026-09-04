import { describe, expect, test } from "bun:test";
import { parseComputerExtraHosts } from "../src/extra-hosts";

describe("COMPUTER_EXTRA_HOSTS", () => {
  test("turns an approved ERP mapping into Docker ExtraHosts syntax", () => {
    expect(parseComputerExtraHosts("erp.netsfera.es=100.64.10.20")).toEqual([
      "erp.netsfera.es:100.64.10.20",
    ]);
  });

  test("accepts more than one unique Tailnet mapping", () => {
    expect(
      parseComputerExtraHosts(
        "erp.netsfera.es=100.64.10.20,mail.netsfera.es=100.127.1.2",
      ),
    ).toEqual([
      "erp.netsfera.es:100.64.10.20",
      "mail.netsfera.es:100.127.1.2",
    ]);
  });

  test.each([
    "erp.netsfera.es=127.0.0.1",
    "*.netsfera.es=100.64.10.20",
    "erp.netsfera.es=192.168.1.2",
    "erp.netsfera.es=100.64.10.20,erp.netsfera.es=100.64.10.21",
    "erp.netsfera.es=100.64.10.20=unexpected",
  ])("rejects unsafe mapping %s", (value) => {
    expect(() => parseComputerExtraHosts(value)).toThrow();
  });
});
