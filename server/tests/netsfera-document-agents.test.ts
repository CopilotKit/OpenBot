import { describe, expect, test } from "bun:test";
import { loadTenantPackage } from "../src/tenant-package";

describe("the Netsfera document agents", () => {
  test("keeps Jefe ERP computerless and enables only the collector", async () => {
    const tenant = await loadTenantPackage(
      new URL("../../examples/netsfera", import.meta.url).pathname,
    );
    const chief = tenant.agents.find((agent) => agent.id === "jefe-erp");
    const collector = tenant.agents.find(
      (agent) => agent.id === "recolector-documentos",
    );

    expect(chief?.configuration).toMatchObject({ computerAccess: "disabled" });
    expect(chief?.skills).toEqual([]);
    expect(collector?.configuration).toMatchObject({
      computerAccess: "enabled",
    });
    expect(collector?.skills).toEqual([
      "skill-creator",
      "crear-proveedor-documental",
    ]);
  });

  test("tells the collector to transfer downloads without using a shell", async () => {
    const tenant = await loadTenantPackage(
      new URL("../../examples/netsfera", import.meta.url).pathname,
    );
    const collector = tenant.agents.find(
      (agent) => agent.id === "recolector-documentos",
    );

    const prompt = collector?.configuration.systemPrompt;
    expect(prompt).toContain(
      "call computer_list_files with path downloads",
    );
    expect(prompt).toContain(
      "Do not call computer_run_command",
    );
    expect(prompt).toContain(
      "message_bot validates each attachment",
    );
  });

  test("ships a provider flow with confirmation and a truthful fallback", async () => {
    const tenant = await loadTenantPackage(
      new URL("../../examples/netsfera", import.meta.url).pathname,
    );
    const creator = tenant.skills.find(
      (skill) => skill.slug === "skill-creator",
    );
    const provider = tenant.skills.find(
      (skill) => skill.slug === "crear-proveedor-documental",
    );

    expect(creator?.instructions).toContain("save_skill");
    expect(creator?.tools).toEqual([]);
    expect(provider?.instructions).toContain("askChoice");
    expect(provider?.instructions).toContain("askApproval");
    expect(provider?.instructions).toContain("human_save_required");
    expect(provider?.instructions).toContain("Never record");
    expect(provider?.tools).toEqual([]);
  });
});
