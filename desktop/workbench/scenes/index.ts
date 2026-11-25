import type { Scene } from "./types";
export const SCENES: readonly Scene[] = [
  {
    id: "setup",
    title: "Setup",
    group: "Setup",
    start: { hash: "", search: "" },
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
