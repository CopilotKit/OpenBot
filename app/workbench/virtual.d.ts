// The virtual module of app/vite.workbench.config.ts: the Desktop page scripts, read from Rust.
declare module "virtual:workbench-desktop-pages" {
  export const DESKTOP_PAGE_SCRIPTS: readonly {
    name: string;
    os: "mac" | "windows" | "any";
    code: string;
  }[];
}
