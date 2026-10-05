import { createReactComponent } from "@tabler/icons-react";

/** User-supplied Lucide Audio Lines geometry, with the same props as our Tabler icons. */
export const IconWaveform = createReactComponent(
  "outline",
  "waveform",
  "IconWaveform",
  [
    ["path", { d: "M2 10v3", key: "line-1" }],
    ["path", { d: "M6 6v11", key: "line-2" }],
    ["path", { d: "M10 3v18", key: "line-3" }],
    ["path", { d: "M14 8v7", key: "line-4" }],
    ["path", { d: "M18 5v13", key: "line-5" }],
    ["path", { d: "M22 10v3", key: "line-6" }],
  ],
);
