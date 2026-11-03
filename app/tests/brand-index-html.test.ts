import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { brandIndexHtml, tenantThemeStyle } from "../src/lib/brand/index-html";

const shell = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const brand = {
  tenantId: "nexqn",
  productName: "NexQN AI",
  shortName: "NexQN",
  websiteUrl: "https://nexqn.vn",
  supportEmail: null,
  logoUrl: null,
  faviconUrl: null,
  themeCss: "",
};

describe("the page shell carries the tenant's brand", () => {
  test("a package favicon becomes the tab icon", () => {
    const html = brandIndexHtml(shell, {
      ...brand,
      faviconUrl: "data:image/svg+xml;base64,PHN2Zy8+",
    });

    expect(html).toContain(
      '<link rel="icon" href="data:image/svg+xml;base64,PHN2Zy8+" />',
    );
  });

  test("no favicon, or one that is not an inlined image, adds no icon link", () => {
    expect(brandIndexHtml(shell, brand)).not.toContain('rel="icon"');
    expect(
      brandIndexHtml(shell, {
        ...brand,
        faviconUrl: "https://elsewhere/x.svg",
      }),
    ).not.toContain('rel="icon"');
  });

  test("the tab title is the product name, not the template's", () => {
    const html = brandIndexHtml(shell, brand);

    expect(html).toContain("<title>NexQN AI</title>");
    expect(html).toContain(
      '<meta name="application-name" content="NexQN AI" />',
    );
    expect(html).not.toContain("<title>OpenBot</title>");
  });

  test("a product name is text, not markup", () => {
    const html = brandIndexHtml(shell, {
      ...brand,
      productName: 'A & B </title><script>alert("x")</script>',
    });

    expect(html).not.toContain("<script>alert");
    expect(html).toContain(
      "<title>A &amp; B &lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</title>",
    );
  });

  test("no theme adds no style element", () => {
    expect(brandIndexHtml(shell, brand)).not.toContain("tenant-theme");
  });

  test("a theme lands in the head, after the pre-paint script, before the body", () => {
    const html = brandIndexHtml(shell, {
      ...brand,
      themeCss: ":root { --primary: oklch(0.51 0.23 277); }",
    });
    const style = html.indexOf('<style id="tenant-theme">');

    expect(style).toBeGreaterThan(html.indexOf("</script>"));
    expect(style).toBeLessThan(html.indexOf("</head>"));
  });
});

describe("the tenant theme outranks the app's own", () => {
  test(":root and .dark become html:root and html.dark", () => {
    const style = tenantThemeStyle(
      ":root { --primary: #4f46e5; }\n.dark { --primary: #818cf8; }",
    );

    expect(style).toContain("html:root { --primary: #4f46e5; }");
    expect(style).toContain("html.dark { --primary: #818cf8; }");
    expect(style).not.toMatch(/(^|[^l]):root/m);
  });

  test("a block written with no space before its brace is rewritten too", () => {
    expect(
      tenantThemeStyle(":root{--radius:0.5rem;}.dark{--radius:0.5rem;}"),
    ).toContain("html:root{--radius:0.5rem;}html.dark{--radius:0.5rem;}");
  });

  test("text that could close the style element is refused", () => {
    expect(() =>
      tenantThemeStyle(":root { --primary: red; } </style><script>x</script>"),
    ).toThrow("Tenant theme must not contain '</'");
  });
});
