import { mock } from "bun:test";

mock.module("@/components/layout/sidebar-toggle", () => ({
  SidebarToggle: () => <button type="button">Toggle sidebar</button>,
}));
