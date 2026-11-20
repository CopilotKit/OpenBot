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
| `mastra.svg` | The glyph from Mastra's own favicon, [mastra.ai/favicon/new-brand/icon.svg](https://mastra.ai/favicon/new-brand/icon.svg) (downloaded 2026-11-18), the mark from its November 2025 [rebrand](https://mastra.ai/blog/rebrand). Its path is verbatim; the black tile behind it is dropped and the glyph drawn in `currentColor`, scaled into the 24-unit box, with a `<title>` and `1em` sizing. The lobehub set still has the old orb, so `shared/marks.test.ts` pins this path |
| `kubernetes.svg` | The Kubernetes icon from the CNCF's own artwork repository, [`cncf/artwork`](https://github.com/cncf/artwork) `projects/kubernetes/icon/color/kubernetes-icon-color.svg`, verbatim apart from a `<title>`. Used under the Linux Foundation's trademark usage guidelines, to name the project |
| `unbiased.svg` | Unbiased AI's own icon, as served at `platform.unbiased.ai/logos/unbiased-icon.svg` and supplied by Unbiased AI for this row, verbatim apart from a `<title>` and `1em` sizing |
| `trustedrouter.svg` | TrustedRouter's own monochrome mark, `trustedrouter-mono.svg` from the public media kit at [trustedrouter.com/media-kit](https://trustedrouter.com/media-kit) (downloaded 2026-11-19), verbatim apart from a `<title>` and `1em` sizing. It is already drawn in `currentColor` in the 24-unit box |

The clouds on Desktop's OpenBot for Business choice come from that set too, as its colour marks:
`aws.svg` (`aws-color.svg`), `azure.svg` (`azure-color.svg`) and `google-cloud.svg`
(`googlecloud-color.svg`), all from `@lobehub/icons-static-svg@1.103.0`, verbatim. Each names a
cloud OpenBot for Business can run on, beside the words "Your own cloud or on-prem", and nothing
more: no badge, no claim of partnership.

`cloudflare.svg` is that set's single-colour Cloudflare mark (`cloudflare.svg`, same version),
verbatim. It marks the Cloudflare row and its "Sign in with" button.

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
