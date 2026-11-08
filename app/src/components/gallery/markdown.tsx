import { useContext } from "react";
import { Streamdown } from "streamdown";
import { markdownComponents, markdownPlugins } from "@/lib/markdown";
import { GalleryStreamingContext } from "./streaming";

/** Bot-authored card prose uses the same renderer and links as a chat reply. */
export function GalleryMarkdown({ children }: { children?: string }) {
  const streaming = useContext(GalleryStreamingContext);
  return (
    <Streamdown
      className="min-w-0 break-words text-sm"
      components={markdownComponents}
      mode={streaming ? "streaming" : "static"}
      plugins={markdownPlugins}
    >
      {children ?? ""}
    </Streamdown>
  );
}
