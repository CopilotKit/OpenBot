import {
  createRootRouteWithContext,
  Navigate,
  Outlet,
} from "@tanstack/react-router";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RouterContext } from "../router-context";
import "@fontsource-variable/inter/wght.css";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  /*
   * An address this build does not know goes home rather than to a dead end. Home sits behind the
   * auth gate, so the guard decides what that means: /sign for a visitor, /onboarding for somebody
   * who has not finished it, the app for everyone else.
   */
  notFoundComponent: () => <Navigate replace to="/" />,
});

function RootComponent() {
  return (
    <div className="min-h-dvh w-full antialiased">
      <ThemeProvider>
        <TooltipProvider>
          <Outlet />
        </TooltipProvider>
      </ThemeProvider>
    </div>
  );
}
