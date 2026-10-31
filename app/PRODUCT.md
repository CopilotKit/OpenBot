# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences use the same app.

- **Company employee (daily end user).** Usually not technical. Asks Bots to do jobs: read an expense claim, turn a meeting note into follow-ups, research a topic. Expects the ease of ChatGPT, Claude or Grok.
- **IT owner (buyer and administrator).** Chooses and deploys OpenBot. Adds Bots, grants tools and connections, answers approvals, and reads the audit log. Needs trust and control.

## Product Purpose

OpenBot is an AI assistant that a company runs on its own infrastructure and can change completely. Any agent that speaks AG-UI arrives as a coworker. Success: employees use it as their everyday assistant, and the IT owner is confident about what each Bot can do.

## Positioning

Bots are coworkers, and you own them. Each Bot has a computer of its own (a real browser with its own logins, files and only the tools you grant). It runs on your infrastructure, with your PostgreSQL and your model choice. A hosted chatbot cannot truthfully say either.

## Operating Context

- The web app in `app/` is the main surface. A Tauri desktop app and a mobile client use the same frame.
- Main areas: chat with a chosen Bot, the Bot's own computer and browser, Bots, skills, routines, connections, memory, approvals, audit, admin and settings.
- OpenBot is a template. Companies clone the repository and rename it through `brand.yaml`.
- A person can pick a skin per account: the default `openbot` skin, OpenDuet, OpenDots or OpenMuse.

## Capabilities and Constraints

- Light and dark mode must both ship finished.
- The skin system stays. This redesign replaces the default `openbot` skin. The other skins stay as alternates.
- Desktop and mobile must both work at native quality.
- Dense admin screens (audit log, approvals, tables, settings) must stay easy to scan.
- Stack: React 19, Vite, Tailwind 4, shadcn and Base UI components, Tabler icons, Motion.

## Brand Commitments

- The new look is opinionated. When a company renames OpenBot, it swaps the name and logo. The visual world stays.
- The design must move away from the generic shadcn look (gray neutrals, Inter, default components).
- The user named Grok and Muse as references for simplicity, polish and elegance. The result must be unique, not a copy of either.
- Binding brand input (pinned 2026-10-28): take the pixelation and color schemes of copilotkit.ai. Pixelation means square-pixel dither fields. The colors are periwinkle `#7480F1` to mint `#23D5A2`, sky `#8DC1F1` to violet `#686FDF`, lilac `#BEC2FF`, pale lavender `#EDEDF5` and deep plum `#35295F`. The rest of that website is not a reference.
- Direction rounds 1 and 2 were rejected as generic. The user likes bold directions, except extreme ones such as a hand-drawn newsprint catalog.

## Evidence on Hand

- Real product copy in `README.md` and `docs/`.
- Real Bots: General Assistant, Knowledge, Risk Analyst, and ten catalog Bots in `examples/fintech/catalog/`.
- No customer logos, testimonials or usage numbers. Do not invent them.

## Product Principles

1. A Bot is a colleague, not a chat widget. It has a name, a computer and a record of its work.
2. Ownership feels calm and solid. Nothing in the interface suggests a hosted service.
3. The conversation leads. Chrome that does not help the current job stays out of the way.
4. Control is visible but quiet. Approvals and audit are part of the product, not an alarm system.
5. Every detail is finished. Rough spacing, type and motion break trust.
