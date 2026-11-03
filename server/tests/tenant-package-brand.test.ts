import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  createApplicationConfiguration,
  loadTenantPackage,
  MAX_BRAND_IMAGE_BYTES,
  type PackageImageFile,
  validateTenantPackage,
} from "../src/tenant-package";

/**
 * The optional brand fields in `brand.yaml`, and what of them the browser is given.
 *
 * Kept out of `tenant-package.test.ts` because everything here is validation, and that suite opens a
 * database at import.
 */

const model =
  "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }";

function validate(
  tenant: string,
  themeCss = "",
  images: PackageImageFile[] = [],
) {
  return validateTenantPackage({
    brand: `tenant: { id: nexqn, product_name: NexQN AI${tenant} }`,
    agents: "agents: []",
    channels: "channels: []",
    model,
    knowledge: "sources: []",
    images,
    themeCss,
  });
}

const svg = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
);

describe("brand fields beyond the product name", () => {
  test("a package that names none keeps working, with the product name as its short name", () => {
    expect(validate("").brand).toEqual({
      shortName: "NexQN AI",
      websiteUrl: null,
      supportEmail: null,
      logoUrl: null,
      faviconUrl: null,
    });
  });

  test("all three are read and trimmed", () => {
    expect(
      validate(
        ", short_name: ' NexQN ', website_url: https://nexqn.vn, support_email: support@nexqn.vn",
      ).brand,
    ).toEqual({
      shortName: "NexQN",
      websiteUrl: "https://nexqn.vn",
      supportEmail: "support@nexqn.vn",
      logoUrl: null,
      faviconUrl: null,
    });
  });

  test("a blank short name is refused rather than shown as nothing", () => {
    expect(() => validate(", short_name: '  '")).toThrow(
      "tenant.short_name must be a non-empty string",
    );
  });

  test.each([
    "http://nexqn.vn",
    "javascript:alert(1)",
    "nexqn.vn",
    "https://user:pass@nexqn.vn",
  ])("a website that is not a plain https: address is refused: %s", (url) => {
    expect(() => validate(`, website_url: '${url}'`)).toThrow(
      "tenant.website_url must be an https: address",
    );
  });

  test.each(["support", "support@nexqn", "a b@nexqn.vn", "<x>@nexqn.vn"])(
    "a support address that is not an email is refused: %s",
    (email) => {
      expect(() => validate(`, support_email: '${email}'`)).toThrow(
        "tenant.support_email must be an email address",
      );
    },
  );
});

describe("a logo and a favicon", () => {
  test("are inlined as data: URIs of their own type", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { brand } = validate(", logo: logo.svg, favicon: icon.png", "", [
      { filename: "logo.svg", bytes: svg },
      { filename: "icon.png", bytes: png },
    ]);

    expect(brand.logoUrl).toBe(
      `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    );
    expect(brand.faviconUrl).toBe("data:image/png;base64,iVBORw==");
  });

  test.each([
    "../logo.svg",
    "/etc/logo.svg",
    "branding/logo.svg",
    "logo.gif",
    "logo",
  ])(
    "a name that is not a plain image filename in the package root is refused: %s",
    (name) => {
      expect(() =>
        validate(`, logo: '${name}'`, "", [
          { filename: "logo.svg", bytes: svg },
        ]),
      ).toThrow(
        "tenant.logo must be the name of an .svg, .png, .webp or .ico file in the package root",
      );
    },
  );

  test("a file the package does not contain is refused by name", () => {
    expect(() => validate(", favicon: missing.svg")).toThrow(
      "tenant.favicon names missing.svg, which this package does not contain",
    );
  });

  test("an image over the size cap is refused, and one at the cap is taken", () => {
    const at = new Uint8Array(MAX_BRAND_IMAGE_BYTES);
    const over = new Uint8Array(MAX_BRAND_IMAGE_BYTES + 1);

    expect(
      validate(", logo: at.png", "", [{ filename: "at.png", bytes: at }]).brand
        .logoUrl,
    ).toStartWith("data:image/png;base64,");
    expect(() =>
      validate(", logo: over.png", "", [{ filename: "over.png", bytes: over }]),
    ).toThrow("tenant.logo (over.png) is larger than 128 KB");
  });
});

describe("what the browser is given", () => {
  test("the brand fields and the validated theme, and nothing about the model or its credential", () => {
    const configuration = createApplicationConfiguration(
      validate(
        ", website_url: https://nexqn.vn",
        "\n:root { --primary: oklch(0.51 0.23 277); }\n",
      ),
    );

    expect(configuration).toEqual({
      brand: {
        tenantId: "nexqn",
        productName: "NexQN AI",
        shortName: "NexQN AI",
        websiteUrl: "https://nexqn.vn",
        supportEmail: null,
        logoUrl: null,
        faviconUrl: null,
        themeCss: ":root { --primary: oklch(0.51 0.23 277); }",
      },
    });
    expect(JSON.stringify(configuration)).not.toContain("openai-key");
  });

  test("a theme that is not allowed stops the package before it can reach the page", () => {
    expect(() =>
      validate("", ":root { --primary: red; } body { background: url(x) }"),
    ).toThrow("Tenant theme must not contain imports or URLs");
  });
});

describe("the shipped NexQN package", () => {
  test("loads, and brands the app as NexQN AI with its theme", async () => {
    const tenantPackage = await loadTenantPackage(
      fileURLToPath(new URL("../../examples/nexqn", import.meta.url)),
    );
    const { brand } = createApplicationConfiguration(tenantPackage);

    expect(brand.tenantId).toBe("nexqn");
    expect(brand.productName).toBe("NexQN AI");
    expect(brand.shortName).toBe("NexQN");
    expect(brand.websiteUrl).toBe("https://nexqn.vn");
    expect(brand.themeCss).toContain("--primary: oklch(0.511 0.262 276.966)");
    expect(brand.logoUrl).toStartWith("data:image/svg+xml;base64,");
    expect(brand.faviconUrl).toBe(brand.logoUrl);
  });

  test("every Bot it registers by default is reachable, and none is the fintech example's", async () => {
    const tenantPackage = await loadTenantPackage(
      fileURLToPath(new URL("../../examples/nexqn", import.meta.url)),
    );

    expect(tenantPackage.agents.map((agent) => agent.id)).toEqual([
      "general-assistant",
      "knowledge",
      "research",
    ]);
    expect(tenantPackage.channels.map((channel) => channel.id)).toEqual([
      "general-assistant",
      "company-knowledge",
      "research",
    ]);
  });
});
