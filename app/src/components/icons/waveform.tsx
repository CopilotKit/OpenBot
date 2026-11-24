import { defineIcon, GLYPH_STROKE } from "@/components/icons";

/** User-supplied Lucide Audio Lines geometry, drawn on the icon set's grid and stroke. */
export const IconWaveform = defineIcon("waveform", [
  ["path", { d: "M2 10v3", key: "line-1", ...GLYPH_STROKE }],
  ["path", { d: "M6 6v11", key: "line-2", ...GLYPH_STROKE }],
  ["path", { d: "M10 3v18", key: "line-3", ...GLYPH_STROKE }],
  ["path", { d: "M14 8v7", key: "line-4", ...GLYPH_STROKE }],
  ["path", { d: "M18 5v13", key: "line-5", ...GLYPH_STROKE }],
  ["path", { d: "M22 10v3", key: "line-6", ...GLYPH_STROKE }],
]);
