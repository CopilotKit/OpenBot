import { afterAll, mock } from "bun:test";
import * as SidebarToggleModule from "@/components/layout/sidebar-toggle";

/*
 * Home's top bar, stood in for by a marker in the files that import this. Only the bar: everything
 * else the module exports stays real. And only for the file that imported it: bun keeps a module
 * mock for the rest of the process, so a later file in the same run would otherwise draw this stub
 * wherever it drew the real bar (the native shell's band test did, in CI's shard 2). The real module
 * goes back when the file is done.
 */
const real = { ...SidebarToggleModule };

mock.module("@/components/layout/sidebar-toggle", () => ({
  ...real,
  SidebarToggleBar: () => <div data-testid="sidebar-toggle-bar" />,
}));

afterAll(() => {
  mock.module("@/components/layout/sidebar-toggle", () => real);
});
