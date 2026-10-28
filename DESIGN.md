---
name: Design Workbench
description: A compact dark studio console for moving from inspiration to local-agent conversation to generated comparisons on one screen.
colors:
  bg: "#0e0f11"
  panel: "#16181c"
  panel-raised: "#1d2024"
  panel-inset: "#111316"
  line: "#2a2e34"
  line-strong: "#3a3f47"
  ink: "#e7e9ec"
  ink-soft: "#a6adb6"
  ink-faint: "#6b7280"
  signal: "#e0913a"
  signal-soft: "#c47c2c"
  signal-tint: "#2a1f12"
  captured: "#5bb98c"
  partial: "#d9a441"
  blocked: "#d1656b"
  focus: "#5aa0e0"
  selected: "#232833"
  shadow: "#00000073"
  backdrop: "#060709ad"
  white: "#ffffff"
typography:
  display:
    fontFamily: "Inter Tight, system-ui, sans-serif"
    fontSize: "1.15rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Inter Tight, system-ui, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.005em"
  body:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.66rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.05em"
    textTransform: "uppercase"
  ui-badge:
    fontSize: "0.58rem"
  ui-tiny:
    fontSize: "0.6rem"
  ui-fine:
    fontSize: "0.62rem"
  ui-micro:
    fontSize: "0.66rem"
  ui-meta:
    fontSize: "0.68rem"
  ui-mono:
    fontSize: "0.7rem"
  ui-small:
    fontSize: "0.72rem"
  ui-control:
    fontSize: "0.76rem"
  ui-field:
    fontSize: "0.78rem"
  ui-body:
    fontSize: "0.82rem"
  ui-emphasis:
    fontSize: "0.85rem"
  ui-title:
    fontSize: "0.95rem"
  ui-heading:
    fontSize: "1.15rem"
rounded:
  none: "0"
  xs: "2px"
  sm: "3px"
  md: "5px"
spacing:
  hairline: "1px"
  xs: "0.25rem"
  sm: "0.4rem"
  md: "0.6rem"
  lg: "0.9rem"
  xl: "1.25rem"
components:
  app-bar-height: "44px"
  control-height: "1.9rem"
  tab-strip-height: "2.1rem"
---

# Design System: Design Workbench

## Overview

**Creative North Star: "The Studio Console."**

Design Workbench is a private, single-user desktop tool that keeps the whole
inspiration → local-agent conversation → generated-comparison loop on one
screen. The interface reads like a compact creative development tool (in the
family of Claude Design and code-adjacent workspaces), not a landing page or a
generic admin dashboard.

Every route is a **workspace that fills the viewport immediately** below a thin
application bar. Navigation and primary controls consume minimal vertical
space so the actual work — thumbnails, conversation, proofs — is visible from
the first pixel. There are no route mastheads, no oversized display headings,
and no decorative whitespace between a title and the tool.

**Key characteristics:**

- a ~44px top application bar (wordmark, inline route tabs, live status dot);
- dark layered panels separated by hairline rules, never floating cards;
- dense grids, tab strips, and split panels instead of stacked sections;
- one warm amber signal for the active mark and the next decisive action;
- tiny monospace metadata labels for evidence, provenance, and proof registers;
- explicit but subordinate loading / error / empty / evidence states.

This replaces the previous "Optical Proofing Bench" editorial world (light
paper, 5.5rem display headings, tall mastheads, large section whitespace),
which was rejected as reading like a landing page rather than a working tool.

## Layout

The shell is a fixed-height column: a thin app bar on top, then a single
`workspace` region that owns the remaining `100dvh`. Each workspace composes
its own dense internal layout:

- **Library** — a filter strip over a two-pane split: a dense inspiration
  thumbnail grid on the left and a persistent selected-example detail panel on
  the right. A category strip docks at the bottom of the grid pane.
- **Studio** — a three-pane console: project + brief + reference selectors on
  the left, the selected-reference tray in the middle, and the local-agent
  conversation on the right, all visible together. Useful defaults are selected
  automatically when data exists.
- **Compare** — a compact tab strip (`ALL 5`, then `V1…V5`) over the proof
  region. `ALL 5` is a dense 5×2 overview (Impeccable column left, Taste column
  right); a selected direction shows the fixed two-column Impeccable/Taste
  detail with the refinement action inline. No repeated per-direction
  metadata blocks and no giant headers.
- **Briefs** — a compact register list beside the canonical-Markdown import.

Horizontal overflow is intentional only for tab strips, filter rails, and the
5×2 overview columns. The tweak bar is a persistent compact control docked
bottom-right of a selected proof.

## Colors

Normative tokens live in the OKLCH-free hex frontmatter (the runtime is a dark
console, so values are authored directly). Roles:

- **bg / panel / panel-raised / panel-inset:** page, working surface, raised
  control layer, and recessed wells.
- **line / line-strong:** hairline and emphasized divisions.
- **ink / ink-soft / ink-faint:** primary, secondary, and metadata text.
- **signal / signal-soft / signal-tint:** the single warm accent — active tab,
  primary action, and its low-alpha fill. Never decorative regions.
- **captured / partial / blocked:** evidence status marks only.
- **focus:** the keyboard focus ring (a distinct cool blue, never signal).

**The Signal Rarity Rule.** The amber signal marks state or the next decisive
action. It does not fill panels or backgrounds.

**The One-Theme Rule.** The console is dark end to end. No surface inverts to a
light editorial panel. All text meets WCAG AA on its panel.

## Typography

- **Display** (Inter Tight 650, ~1.15rem): the single workspace title inside a
  panel header — compact, never a masthead.
- **Headline** (Inter Tight 650, ~0.95rem): panel and section titles.
- **Body** (system sans 400, ~0.82rem): operational copy, capped near 68ch.
- **Label** (mono 600, ~0.66rem, uppercase): metadata, filters, evidence,
  proof registers, tab kickers.

Named faces are progressive enhancement over the system stack; the fallback
stacks are required for the local-first build. Bricolage Grotesque and the old
5.5rem display scale are removed.

**The Register Rule.** Mono is metadata, proof notation, and machine output —
not readable body copy.

## Elevation & Shapes

Flat by default. Depth comes from layered panel tones and hairline rules, not
shadows. The one exception is the detail dialog / drawer overlay and the tweak
popover, which use a single soft shadow plus a dark scrim. Controls use small
radii (`3–5px`); the tool is square-leaning, not pill-based.

## Components

### Application bar
Wordmark, inline route tabs (Library / Studio / Compare / Briefs), and a live
status dot with terse status text. Height ~44px, hairline bottom border. The
active route tab carries the amber underline.

### Tab strips
Compare directions and Studio projects render as horizontal tab strips with a
mono index kicker (`V1`, `ALL`) above a short label. Active tab: amber text +
underline. Strips scroll horizontally rather than wrap.

### Thumbnail grid (inspiration)
Dense grid of reference cells: lead image, title, aesthetic family, and a small
evidence-status mark. The cell is the button. Selecting a cell fills the
persistent detail panel; it does not open a full-screen route.

### Detail panel / dialog
Selected-example detail shows source, visual vocabulary, analysis ledger,
evidence limitation, and the Copy Image Prompt / Copy Brief actions. On wide
screens it is a docked right panel; the modal dialog variant is retained for
keyboard/focus flows and small screens.

### Proof pair
Impeccable (left) and Taste Skill (right) occupy equal isolated frames sharing
one direction and one viewport control. Missing/error/loading states render at
the same structural level, as compact labels — never dominant red failures.

### Tweak bar
A persistent compact control docked bottom-right of a selected proof. It reads
the safe `workbench.json` manifest and posts validated `design-workbench:tweak`
messages to the isolated frame. Categories follow the manifest (heading font,
size, accent, motion, weight, reveal, etc.).

## Do's and Don'ts

### Do
- Fill the first viewport with the actual tool; keep chrome under ~44px.
- Use layered panels, hairline rules, and tab strips before any card.
- Keep evidence, provenance, and isolated variant state visible but subordinate.
- Preselect useful defaults (first project, latest brief, matching references,
  `ALL 5` overview) whenever data exists.
- Gate motion behind `prefers-reduced-motion: no-preference`; keep it to state
  transitions.
- Keep the tweak manifest / postMessage / iframe-isolation contracts intact.

### Don't
- Add route mastheads, 3rem+ display headings, or whitespace before the tool.
- Reintroduce the light editorial paper world or its CSS.
- Use the amber signal as decoration, or invert any surface to light.
- Render blocked/partial evidence as dominant failures; they are labels.
- Add Tailwind, a component framework, or rounded dashboard cards.
- Claim generated artifacts where only placeholders exist.
