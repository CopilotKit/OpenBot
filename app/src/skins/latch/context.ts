import { createContext, useContext } from "react";

/** Lets the home screen's top bar open the frame's ☰ menu, as Latch's ⋮ does. */
export const LatchMenuContext = createContext<{ openMenu: () => void }>({
  openMenu: () => {},
});

export function useLatchMenu() {
  return useContext(LatchMenuContext);
}
