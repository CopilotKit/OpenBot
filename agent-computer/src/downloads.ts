import { mkdir, open, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Download, Page } from "playwright";

/** Keep browser downloads in the Bot workspace instead of Playwright's disposable temp directory. */
export const DOWNLOADS_DIRECTORY = join(
  process.env.WORKSPACE_DIR ?? "/workspace",
  "downloads",
);

function safeSuggestedName(suggested: string): string {
  const name = basename(suggested.replaceAll("\\", "/"))
    .replaceAll("\0", "")
    .trim();
  return name || "download";
}

/**
 * Claim a destination without overwriting an earlier invoice.
 *
 * The empty placeholder makes simultaneous downloads choose different names. Playwright's saveAs
 * then replaces that file with the completed download.
 */
async function reservePath(
  directory: string,
  suggested: string,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const name = safeSuggestedName(suggested);
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length) || "download";

  for (let copy = 1; ; copy += 1) {
    const candidate = join(
      directory,
      copy === 1 ? name : `${stem} (${copy})${extension}`,
    );
    try {
      const placeholder = await open(candidate, "wx");
      await placeholder.close();
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export async function persistDownload(
  download: Download,
  directory = DOWNLOADS_DIRECTORY,
): Promise<string> {
  const destination = await reservePath(
    directory,
    download.suggestedFilename(),
  );
  try {
    await download.saveAs(destination);
    return destination;
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Attach before navigation so every attachment download is persisted automatically. */
export function persistPageDownloads(
  page: Page,
  directory = DOWNLOADS_DIRECTORY,
): void {
  page.on("download", (download) => {
    void persistDownload(download, directory).catch((error) => {
      console.error(
        JSON.stringify({
          type: "computer-download-failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  });
}
