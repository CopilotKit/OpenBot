import { createContext, type ReactNode, useContext, useState } from "react";

const TurnHoverContext = createContext<{
  active: string | null;
  setActive: (id: string | null) => void;
} | null>(null);

export function TurnHoverProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<string | null>(null);
  return (
    <TurnHoverContext.Provider value={{ active, setActive }}>
      {children}
    </TurnHoverContext.Provider>
  );
}
export function useTurnHover() {
  return useContext(TurnHoverContext);
}

/** Rows stay separate for scroll anchoring, but share the interaction area of their turn. */
export function TurnHoverSurface({
  turnId,
  children,
}: {
  turnId?: string;
  children: ReactNode;
}) {
  const hover = useTurnHover();
  return (
    <div
      onPointerEnter={() => {
        if (turnId) hover?.setActive(turnId);
      }}
      onPointerLeave={() => {
        if (turnId) hover?.setActive(null);
      }}
    >
      {children}
    </div>
  );
}
