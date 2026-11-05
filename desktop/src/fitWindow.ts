import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";

/**
 * Ask the shell for a taller window whenever the step on screen is taller than the window.
 *
 * Some steps grow as they are used (a provider's sign-in opening under its row, an answer arriving),
 * and the window is sized for the common case. The shell decides how much it may grow on this
 * monitor and never shrinks it; see `fit_setup_window`. Past what the screen allows, the page
 * scrolls as before.
 */
export function useWindowFitsContent() {
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const wanted = document.documentElement.scrollHeight;
        if (wanted > window.innerHeight) {
          void invoke("fit_setup_window", { contentHeight: wanted }).catch(
            () => {},
          );
        }
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
}
