# Design System Audit

Measure how far an existing Expo app has drifted from a single visual source of truth, then document or extend components with a consistent template.

Run the audit **before** proposing changes. Report findings first; apply fixes only when asked.

## 0. Locate the directories first

Do **not** assume a `src/` folder. The default `create-expo-app` template puts `app/`, `components/`, and `constants/` at the repo root, and running the checks below against a nonexistent `src/` returns zero hits - a false clean bill.

Before any grep, identify and record:

- **Source directories** - every directory holding app code (`src`, or e.g. `app components constants hooks`).
- **Theme location** - the token directory or file (`src/theme`, `theme`, `constants`, or a single `theme.ts`). If none exists yet, note that as the first finding.
- **The existing system, if any** - a styling library in `package.json` (NativeWind, Tamagui, Restyle, Unistyles, styled-components) per `SKILL.md` "Adopt Before You Build". Record which one. The checks below assume this skill's defaults - plain `StyleSheet`, `boxShadow` strings, one `src/theme` entry point. An app on a styling library fails several of them while being perfectly consistent in its own idiom. Audit such an app against its own system: its token names, its scale, its config file as the single entry point. Adapt or skip a check rather than reporting a false violation.

Substitute them into the shell variables below; every check uses them.

```bash
SRC="app components constants"   # this project's source directories
THEME="constants"                # this project's theme directory (excluded from hits)
```

## 1. Token coverage checks

Run from the repo root. Each hit outside the theme directory is a candidate for tokenization - not automatically a violation (check for the "one-off, with a comment" exemption in `SKILL.md`).

```bash
# Hardcoded hex colors outside the theme
grep -rEn '#[0-9a-fA-F]{3,8}\b' $SRC --include='*.tsx' --include='*.ts' | grep -v "^$THEME/"

# Raw fontSize (should come from the type ramp / ThemedText)
grep -rn 'fontSize:' $SRC --include='*.tsx' | grep -v "^$THEME/"

# Spacing values outside the named steps of the scale.
# The whitelist is the project's actual scale (here: the example scale from
# SKILL.md) - substitute the project's steps before running. Multiples of 4
# that are not named steps (12, 20, 40, ...) are flagged on purpose: the rule
# is "use the nearest step". If one keeps recurring, the fix is to add it to
# the scale and to this whitelist, not to ignore the hits.
grep -rEn '(padding|margin|gap)[A-Za-z]*:\s*[0-9]+' $SRC --include='*.tsx' \
  | grep -vE ':\s*(0|4|8|16|24|32|48)\b' | grep -v "^$THEME/"

# Raw borderRadius (should use radius tokens)
grep -rn 'borderRadius:' $SRC --include='*.tsx' | grep -v "^$THEME/"

# Legacy shadows (banned by expo-native-ui - must be boxShadow)
grep -rEn 'shadow(Color|Offset|Opacity|Radius)|elevation:' $SRC --include='*.tsx'

# Multiple theme entry points (there must be exactly one)
ls src/theme.ts src/theme/index.ts theme.ts theme/index.ts constants/theme.ts 2>/dev/null

# Candidate files with custom tappables but no explicit accessibility role/label (inspect each control; text or forwarded props may supply labels)
grep -rln '<Pressable' $SRC --include='*.tsx' | xargs grep -LE 'accessibility(Role|Label)'
```

Then run the candidate checks in `native-slop.md`. Inspect the rendered result: token checks alone cannot establish readable dark mode, spacing hierarchy, or appropriate shadows.

For a Tailwind project, also check for values that bypass `global.css` variables: arbitrary-value classes like `p-[13px]` or `text-[#5B21B6]`.

```bash
grep -rEn 'className="[^"]*\[[^"]*\]' $SRC --include='*.tsx'
```

## 2. Scoring

Turn raw hit counts into a comparable score so runs can be tracked over time:

```bash
# Source lines of code (the denominator)
find $SRC -name '*.tsx' -o -name '*.ts' | xargs wc -l | tail -1
```

For each category: **score = escapes per 100 source lines** (hits ÷ SLOC × 100, one decimal).

| Score per category | Reading |
|---|---|
| < 0.5 | Healthy - fix opportunistically |
| 0.5 - 2.0 | Drifting - schedule cleanup for the worst files |
| > 2.0 | Systemic - the token or component for this category is missing or unused; fix the system first (see §5) |

Report the per-category scores in the summary. The overall priority order falls out of the scores: the highest-scoring category is usually the first migration target.

## 3. Component completeness

For each component in the shared components directory (`src/components/`, or `components/` in a root-level layout), check it against the contract in `SKILL.md`:

| Check | Pass condition |
|---|---|
| Variants | Visual intent is a `variant` prop, not boolean soup (`isPrimary`, `isGhost`) |
| Sizes | Sizes map to spacing/typography tokens |
| Pressed state | Tappable components give pressed feedback via a `Pressable` style function |
| Disabled / loading | Handled, and disabled blocks `onPress` |
| Style override | Accepts `style`, merged last |
| Accessibility | Role and applicable disabled/busy/selected state exposed; label survives loading and identifies icon-only controls; touch target ≥ 44pt (48dp Android) |
| Tokens only | No literals that duplicate a theme value |

## 4. Report format

```markdown
## Design System Audit

### Summary
Screens reviewed: [X] | Components reviewed: [X] | Issues: [X]

### Token coverage
| Category | Tokens defined | Escapes found | Score (per 100 SLOC) | Worst offenders |
|---|---|---|---|---|
| Colors | [X] | [X] hardcoded hex | [X.X] | [files] |
| Spacing | [X] | [X] non-step values | [X.X] | [files] |
| Typography | [X] | [X] raw fontSize | [X.X] | [files] |
| Radius / shadows / motion | [X] | [X] | [X.X] | [files] |

### Component completeness
| Component | Variants | States | Overrides | Tokens | Notes |
|---|---|---|---|---|---|
| Button | OK | missing pressed | OK | OK | ... |

### Extraction candidates
Views repeated across ≥2 screens that are still colocated or duplicated:
1. [view] - appears in [screens] - suggested name: [Component]

### Priority actions
1. [Highest-leverage fix - usually the most-duplicated escaped value]
2. ...
```

## 5. Adopting incrementally

An app with dozens of escapes is migrated in order, never big-bang. A big-bang conversion produces one huge unreviewable diff and usually stalls half-done.

1. **Create the tokens first.** Derive the scales from the values the audit found most often, snapped to the grid. A theme built from the app's real values gets adopted; an aspirational one gets bypassed.
2. **Typography before spacing.** Convert raw `fontSize` to the `type` ramp + `ThemedText` first: it is the highest-visibility win and touches the fewest layout decisions. Then spacing, then colors, then radius/shadows.
3. **Convert one worst-offender file completely** and use it as the reference pattern for the rest of the migration.
4. **Then convert per-screen**, one screen per commit, using the audit greps scoped to that screen to verify it comes out clean.
5. **Re-run the audit after each phase** and record the scores from §2 - they should fall monotonically.

## 6. Documenting an existing component

```markdown
## Component: [Name]

[What it is and when to use it - one paragraph.]

### Variants
| Variant | Use when |
|---|---|
| primary | The screen's single main action |

### Props
| Prop | Type | Default | Notes |
|---|---|---|---|

### States
default / pressed / disabled / loading - visual + behavior for each.

### Accessibility
Role, touch target, screen reader label.

### Do / Don't
| Do | Don't |
|---|---|
| [best practice] | [anti-pattern seen in this repo] |
```

## 7. Proposing a new component

Before designing a new primitive, prove the existing set can't cover it:

```markdown
## Proposed: [Name]

### Problem
[The repeated need, and the ≥2 screens that have it.]

### Why existing components aren't enough
| Closest component | What's shared | What's missing |
|---|---|---|

### API
Props table (variant / size / state / style only - content via children).

### Tokens used
Colors: [...] Spacing: [...] Typography: [...] Radius: [...]

### Open questions
[Decisions that need a human, e.g. does this need a destructive variant?]
```

If the "what's missing" column is empty for any row, extend that component's variants instead of adding a new one.
