import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

type DrawerControl = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

const DrawerContext = createContext<DrawerControl>({
  open: false,
  setOpen: () => {},
});

/** Whether the app's menu is open, for the menu button in each top screen's header. */
export function DrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return (
    <DrawerContext.Provider value={value}>{children}</DrawerContext.Provider>
  );
}

export function useDrawer() {
  return useContext(DrawerContext);
}
