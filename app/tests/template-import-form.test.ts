import { expect, test } from "bun:test";
import {
  emptyTemplateImportForm,
  templateImportFormSchema,
  templateInstallInputFrom,
} from "@/lib/templates/form";
import type { TemplatePlan } from "@/lib/templates/queries";

function planWith(endpoint: Partial<TemplatePlan["endpoint"]>): TemplatePlan {
  return {
    digest: "d".repeat(64),
    connectors: [],
    components: [],
    skills: [],
    endpoint: {
      required: false,
      reason: null,
      requiresKey: false,
      ...endpoint,
    },
    // The two agree by construction on the server, and this helper is only interesting when they do.
    runsOn: endpoint.required ? "address" : "in_process",
    slugDecisions: {},
  };
}

test("an address is checked for shape and nothing else", () => {
  expect(
    templateImportFormSchema.safeParse({
      ...emptyTemplateImportForm,
      source: "openbot_template: 1",
      endpoint: "renewals.example.com/agui",
    }).success,
  ).toBeFalse();

  expect(
    templateImportFormSchema.safeParse({
      ...emptyTemplateImportForm,
      source: "openbot_template: 1",
      endpoint: "https://renewals.example.com/agui",
    }).success,
  ).toBeTrue();
});

test("a blank address and a blank key are omitted rather than sent empty", () => {
  const input = templateInstallInputFrom(
    { ...emptyTemplateImportForm, source: "openbot_template: 1" },
    planWith({}),
    { from: "paste" },
  );
  expect(input).not.toHaveProperty("endpoint");
  expect(input).not.toHaveProperty("auth");
  expect(input.digest).toBe("d".repeat(64));
  expect(input.from).toBe("paste");
});

test("the key is sent under the header name the template carried", () => {
  const input = templateInstallInputFrom(
    {
      ...emptyTemplateImportForm,
      source: "openbot_template: 1",
      endpoint: " https://renewals.example.com/agui ",
      authValue: "  a-key  ",
    },
    planWith({
      required: true,
      reason: "remote",
      requiresKey: true,
      authHeader: "X-Api-Key",
    }),
    { from: "gallery", sourceRef: "tpl_1" },
  );
  expect(input.endpoint).toBe("https://renewals.example.com/agui");
  expect(input.auth).toEqual({ header: "X-Api-Key", value: "a-key" });
  expect(input.sourceRef).toBe("tpl_1");
});

test("a template that carried no header name still authenticates the ordinary way", () => {
  const input = templateInstallInputFrom(
    {
      ...emptyTemplateImportForm,
      source: "openbot_template: 1",
      authValue: "a-key",
    },
    planWith({ required: true, reason: "remote", requiresKey: true }),
    { from: "paste" },
  );
  expect(input.auth).toEqual({ header: "Authorization", value: "a-key" });
});

test("overwrite is not one of the answers a colliding slug has", () => {
  const parsed = templateImportFormSchema.safeParse({
    ...emptyTemplateImportForm,
    source: "openbot_template: 1",
    slugDecisions: { "check-renewal-risk": "overwrite" },
  });
  expect(parsed.success).toBeFalse();
});

/**
 * The regression: `endpoint` and `auth` were emitted from whatever the form happened to hold.
 *
 * One form survives "Read a different file", so an address and a key typed for template A reached
 * template B's install — and where B is a managed Bot the consent screen renders neither box, so
 * the screen promised a coworker in the deployment's own container while the install pointed one at
 * A's host with A's credential in the vault. What the plan did not ask for is not sent.
 */
test("a field the consent screen is not showing is never sent", () => {
  const carried = {
    ...emptyTemplateImportForm,
    source: "openbot_template: 1",
    endpoint: "https://a.example/agui",
    authValue: "sk-live-1",
  };

  // A managed Bot on this deployment: neither box is on the screen.
  const managed = templateInstallInputFrom(carried, planWith({}), {
    from: "paste",
  });
  expect(managed).not.toHaveProperty("endpoint");
  expect(managed).not.toHaveProperty("auth");

  // An address of its own, sitting behind nothing: the address travels and the key does not.
  const open = templateInstallInputFrom(
    carried,
    planWith({ required: true, reason: "remote", requiresKey: false }),
    { from: "paste" },
  );
  expect(open.endpoint).toBe("https://a.example/agui");
  expect(open).not.toHaveProperty("auth");
});
