import { createRoot } from "react-dom/client";
import { ThemeProvider, useTheme } from "@/components/theme-provider";

/**
 * The app's theme provider as a page of its own, for theme-follows-system.test.tsx to bundle and
 * load in Chromium under the app's real `index.html`. The buttons stand in for the Appearance
 * setting: each one makes the choice the setting makes.
 */
function Choices() {
  const { theme, setTheme } = useTheme();
  return (
    <div data-setting-shows={theme}>
      {(["system", "light", "dark"] as const).map((choice) => (
        <button key={choice} onClick={() => setTheme(choice)} type="button">
          {choice}
        </button>
      ))}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("no #root");
createRoot(root).render(
  <ThemeProvider>
    <Choices />
  </ThemeProvider>,
);
