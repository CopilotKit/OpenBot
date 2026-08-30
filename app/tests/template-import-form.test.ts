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
