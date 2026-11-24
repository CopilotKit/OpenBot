// Standalone CSS for the buddy avatar, injected once on first render. Colors are
// themeable via CSS custom properties, each falling back to the host app's
// variables (e.g. --line, --sea-ink) and finally to a hard default — so it looks
// right both inside the demo app and in a bare page.

export const buddyCss = `
.buddy-avatar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.375rem;
}
.buddy-avatar--full { width: 100%; }

.buddy-avatar__frame { position: relative; }
.buddy-avatar__frame--full { width: 100%; }

.buddy-avatar__bubble {
  position: relative;
  aspect-ratio: 1 / 1;
  width: 100%;
  overflow: hidden;
  border-radius: 9999px;
  border: 1px solid var(--buddy-border, var(--line, #e5e7eb));
  background: var(--buddy-bg, #ffffff);
}
.buddy-avatar__bubble--shadow-sm { box-shadow: 0 1px 2px 0 rgba(0,0,0,.05); }
.buddy-avatar__bubble--shadow-md { box-shadow: 0 4px 6px -1px rgba(0,0,0,.1), 0 2px 4px -2px rgba(0,0,0,.1); }
.buddy-avatar__bubble--shadow-lg { box-shadow: 0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1); }
.buddy-avatar__bubble--shadow-xl { box-shadow: 0 20px 25px -5px rgba(0,0,0,.1), 0 8px 10px -6px rgba(0,0,0,.1); }

.buddy-avatar__media {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.buddy-avatar__external {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.125rem;
  text-align: center;
}

.buddy-avatar__label--name {
  font-size: 0.875rem;
  line-height: 1.25rem;
  font-weight: 600;
  color: var(--buddy-name-color, var(--sea-ink, #1f2937));
}
.buddy-avatar__label--status {
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--buddy-status-color, var(--sea-ink-soft, #6b7280));
}

.buddy-avatar__inset {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  max-width: 88%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  border-radius: 9999px;
  background: var(--buddy-inset-bg, rgba(255,255,255,0.85));
  padding: 0.125rem 0.625rem;
  box-shadow: 0 1px 2px rgba(0,0,0,.08);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.buddy-avatar__inset--top { top: 0.5rem; }
.buddy-avatar__inset--bottom { bottom: 0.5rem; }
.buddy-avatar__inset.buddy-avatar__label--name { font-size: 0.75rem; }
.buddy-avatar__inset.buddy-avatar__label--status { font-size: 11px; }

.buddy-avatar__thought {
  position: absolute;
  right: 0;
  top: 0.5rem;
  z-index: 20;
  transform: translateX(35%);
  pointer-events: none;
}
.buddy-avatar__thought-bubble {
  position: relative;
  white-space: nowrap;
  border-radius: 1rem;
  border: 1px solid var(--buddy-border, var(--line, #e5e7eb));
  background: var(--buddy-bg, #ffffff);
  padding: 0.25rem 0.75rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--buddy-name-color, var(--sea-ink, #1f2937));
  box-shadow: 0 4px 6px -1px rgba(0,0,0,.1), 0 2px 4px -2px rgba(0,0,0,.1);
}
.buddy-avatar__thought-bubble::before,
.buddy-avatar__thought-bubble::after {
  content: '';
  position: absolute;
  border-radius: 9999px;
  border: 1px solid var(--buddy-border, var(--line, #e5e7eb));
  background: var(--buddy-bg, #ffffff);
}
.buddy-avatar__thought-bubble::before { bottom: -0.375rem; left: 0.75rem; width: 0.625rem; height: 0.625rem; }
.buddy-avatar__thought-bubble::after { bottom: -0.875rem; left: 0.25rem; width: 0.375rem; height: 0.375rem; }

/* Overlay wrapper generates no box, so its children position against the bubble. */
.buddy-avatar__overlay { display: contents; }

/* ---- layers (animated backgrounds & effects) ---- */
.buddy-avatar__layers { position: absolute; inset: 0; pointer-events: none; }
.buddy-avatar__layer { pointer-events: none; }
.buddy-avatar__layer-canvas { width: 100%; height: 100%; display: block; }
.buddy-avatar__layer-media { width: 100%; height: 100%; object-fit: cover; display: block; }

/* disco ball (CSS engine): a faceted ball hung from a thin line */
.buddy-avatar__disco {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; height: 100%;
}
.buddy-avatar__disco-line { width: 1px; height: 14%; background: rgba(255,255,255,0.5); }
.buddy-avatar__disco-ball {
  width: 34%; aspect-ratio: 1; border-radius: 9999px;
  background:
    repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0 10%, rgba(255,255,255,0.06) 10% 20%),
    repeating-linear-gradient(90deg, rgba(0,0,0,0.18) 0 10%, rgba(255,255,255,0.06) 10% 20%),
    radial-gradient(circle at 32% 28%, #ffffff, #9fb4c8 55%, #43536b);
  box-shadow: 0 0 14px rgba(180,220,255,0.6), inset -6px -6px 12px rgba(0,0,0,0.3);
}

/* Motion for CSS-engine layers is gated behind reduced-motion preference. */
@media (prefers-reduced-motion: no-preference) {
  .buddy-avatar__disco-ball { animation: buddy-disco-spin 6s linear infinite; }
  @keyframes buddy-disco-spin {
    0% { filter: hue-rotate(0deg) brightness(1); }
    50% { filter: hue-rotate(22deg) brightness(1.15); }
    100% { filter: hue-rotate(0deg) brightness(1); }
  }
  /* Opt-in animated gradient for css layers: pair with background-size via the css value. */
  .buddy-avatar__layer--anim-gradient { background-size: 200% 200%; animation: buddy-gradient-pan 8s ease infinite; }
  @keyframes buddy-gradient-pan { 0% { background-position: 0% 50% } 50% { background-position: 100% 50% } 100% { background-position: 0% 50% } }
}
`;

const STYLE_ID = "buddy-avatar-styles";
let injected = false;

/** Inject the buddy CSS once into <head>. No-op on the server or if already present. */
export function injectBuddyStyles(): void {
  if (injected) return;
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) {
    injected = true;
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = buddyCss;
  document.head.appendChild(style);
  injected = true;
}
