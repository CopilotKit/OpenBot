import type { Scene } from "./types";
export const SCENES: readonly Scene[] = [
  {
    id: "setup",
    title: "Setup",
    group: "Setup",
    // A first run you can click through: sign in, the agreement, then setup (states.ts).
    start: { hash: "#first-run", search: "" },
  },
  {
    id: "setup-status",
    title: "Local status",
    group: "Setup",
    start: { hash: "#status", search: "" },
  },
  {
    id: "setup-update",
    title: "Update",
    group: "Setup",
    start: { hash: "#update-short", search: "" },
  },
];
