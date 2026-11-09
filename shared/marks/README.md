# Vendored brand marks

Vendored rather than fetched, because the setup window draws before it has any network guarantee.
Most come from [`@lobehub/icons-static-svg`](https://github.com/lobehub/lobe-icons), MIT licensed.
Where that set has none, the mark is the vendor's own published artwork, taken from the project's
own repository:

| File | Source |
| --- | --- |
| `ag2.svg` | [`ag2ai/ag2`](https://github.com/ag2ai/ag2) `website/static/img/favicon-dark.svg`, verbatim apart from a `<title>` |
| `agno.svg` | [`agno-agi/docs`](https://github.com/agno-agi/docs) `favicon.png`, embedded unchanged in an SVG |
| `langgraph.svg` | LangChain's own symbol, `LangChain_Symbol_Black.svg` from the brand pack on [langchain.com/brand-assets](https://www.langchain.com/brand-assets) (downloaded 2026-11-09), verbatim apart from a `<title>`. Named for the harness id it belongs to |
| `langroid.svg` | [`langroid/langroid`](https://github.com/langroid/langroid) `public/logo_light.png`, scaled to 128 px and embedded in an SVG |
| `unbiased.svg` | Unbiased AI's own icon, as served at `platform.unbiased.ai/logos/unbiased-icon.svg` and supplied by Unbiased AI for this row, verbatim apart from a `<title>` and `1em` sizing |

Google has two from that set. `google.svg` is the single-colour G the model rows use.
`google-color.svg` is the standard colour G, and it is the one that goes beside a sign-in: Google's
sign-in guidelines allow no other G on a "Sign in with" button, so the desktop's Google row uses it.

The two PNGs sit inside an SVG wrapper only so every mark is one file type: both apps resolve a
mark by globbing `*.svg`, and a second extension would mean a second rule in each.

Each of these carries a `<title>` naming the product, as every lobehub mark already does, because
the linter rejects an SVG without one.

Renamed to the harness or provider id they belong to, so a row finds its mark by its own id and
there is no second mapping to keep in step.

Each mark is its owner's trademark, used to identify that product in a picker and for nothing else.
**Nothing here is invented.** A brand that publishes no mark shows its name alone. A monogram we
drew would read as the vendor's own, which is the thing a trademark holder actually objects to.

Every row shows its name whether or not it has a mark. The mark sits beside the name and never
replaces it.
