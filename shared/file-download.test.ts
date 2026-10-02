import { describe, expect, test } from "bun:test";
import { contentDisposition, downloadHeaders } from "./file-download";

describe("workspace download headers", () => {
  test("declares an opaque attachment and its exact byte length", () => {
    const headers = downloadHeaders("report.pdf", 42);

    expect(headers).toMatchObject({
      "Content-Type": "application/octet-stream",
      "Content-Length": "42",
      "Content-Disposition":
        "attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
  });

  test("keeps a unicode name in filename* and a safe ASCII fallback", () => {
    expect(contentDisposition("报告.pdf")).toBe(
      "attachment; filename=\"__.pdf\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf",
    );
  });

  test("neutralises CRLF so a filename cannot add response headers", () => {
    const headers = new Headers(
      downloadHeaders("evil\r\nX-Injected: yes.txt", 4),
    );

    expect(headers.get("content-disposition")).not.toMatch(/[\r\n]/);
    expect(headers.get("x-injected")).toBeNull();
  });
});
