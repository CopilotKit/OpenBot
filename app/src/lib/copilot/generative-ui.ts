/**
 * What a Bot is told about drawing an interface it wrote itself.
 *
 * The SDK ships a default set of guidelines, and they describe shadcn/ui: rounded cards, a violet
 * accent, its own spacing scale. OpenBot does not look like that. The app's palette is deliberately
 * without colour — every token in styles.css sits at chroma zero except the destructive red and the
 * success teal — so the default guidance produces something that reads as a foreign widget dropped
 * into the transcript rather than part of it.
 *
 * This is a prompt, so it is written for a model rather than for a person: concrete values it can
 * copy, and the few rules that are actually load-bearing.
 *
 * WHY THE COLOURS ARE LITERAL. The generated interface renders inside a sandboxed iframe with no
 * same-origin access to this app. It cannot reach the stylesheet, the theme class, or the CSS custom
 * properties the rest of the UI is built from, so anything it should match has to be written out
 * here in full. Referring it to `--muted-foreground` would produce an unstyled document.
 *
 * WHY prefers-color-scheme AND NOT THIS APP'S THEME. For the same reason: the iframe is a separate
 * document and cannot see which theme the person picked. `prefers-color-scheme` is the only signal
 * that crosses, so a generated interface follows the browser rather than the app's own switch. A
 * person who has overridden their OS theme in OpenBot will see a generated interface that disagrees
 * with the surface around it. That is a known limitation of the sandbox rather than something this
 * text can fix.
 */
export const GENERATIVE_UI_DESIGN_SKILL = `You are generating a self-contained interface that renders inside a sandboxed iframe in OpenBot's chat transcript. It must look like it belongs to OpenBot, not like a widget from somewhere else.

PALETTE. OpenBot is neutral by design. Use greys for structure and reserve colour for meaning.
- Light: background #fafafa, surface #ffffff, text #0a0a0a, muted text #636363, border #e5e5e5.
- Dark: background #0a0a0a, surface #171717, text #fafafa, muted text #a1a1a1, border rgba(255,255,255,0.10).
- Only two accents, and only when they carry meaning: #e7000b destructive and #009689 success in light, #ff6467 and #00bba7 in dark.
- Never introduce a brand hue, gradient, or coloured header. A purple or blue accent is wrong here.

CHARTS. Series colours are steps of grey, not a rainbow: #d4d4d4, #737373, #525252, #404040, #262626. Distinguish series by ordering, direct labels, and shape rather than by hue. If a series means "bad", the destructive red is allowed for that one series.

TYPE. font-family: Inter, ui-sans-serif, system-ui, sans-serif. Body 14px/1.5. Headings 15-16px, weight 600, no letter-spacing tricks. Numerals in tables and metrics: font-variant-numeric: tabular-nums.

SHAPE AND SPACING. border-radius: 0.55rem on cards and controls, 0.375rem on small chips. 1px solid borders, never a drop shadow for elevation. Pad containers 12-16px. Space stacked blocks 8-12px.

DARK MODE IS REQUIRED. Define the light palette first, then override inside @media (prefers-color-scheme: dark). Set an explicit background and colour on body — the iframe paints on nothing, so a transparent body shows through wrongly.

LAYOUT. Assume a narrow column: roughly 320-680px wide, inside a chat message. Design for the narrow case first and let it grow. Never set a fixed pixel width on the outermost element; use max-width: 100%, flexbox or grid, and box-sizing: border-box everywhere. Anything wide — a table, a chart, a code block — scrolls inside its own container with overflow-x: auto. The page itself must never scroll sideways.

HONESTY ABOUT DATA. You have no access to this deployment's data. Every number you render is one you were given or one you made up, so never present an invented figure as a reading from OpenBot. If you are illustrating rather than reporting, label it as an example on the interface itself.

MECHANICS.
- Keep it self-contained: inline the CSS and the JS. CDN <script> and <link> tags do load, so Chart.js, D3 and similar are available when a chart genuinely needs them; prefer plain SVG or CSS for anything simple.
- No network calls to this deployment. The iframe has no session and no same-origin access; a fetch to /api will fail.
- Guard every read of browser storage in try/catch. It throws outright in some contexts.
- Interactive controls need a visible focus ring, real button elements, and hit targets of at least 32px.
- Prefer one clear interface over a dashboard of panels. A single legible chart beats four cramped ones.`;
