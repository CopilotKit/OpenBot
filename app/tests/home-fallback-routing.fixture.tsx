import { mock } from "bun:test";

mock.module("@/components/layout/sidebar-toggle", () => ({
  SidebarToggleBar: () => <div data-testid="sidebar-toggle-bar" />,
}));
