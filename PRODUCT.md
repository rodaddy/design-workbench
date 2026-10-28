# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Design Workbench is a private, single-user tool for a local design researcher
who collects references, turns observations into reusable briefs, and compares
generated frontend directions.

## Product Purpose

Design Workbench keeps three connected workflows in one local application:

- Library stores, filters, edits, and inspects normalized design references
  while keeping provenance and evidence limitations visible.
- Briefs imports and validates the canonical Markdown artifact produced by the
  project-owned `design-brief-grill` skill.
- Compare creates up to five ordered aesthetic directions and presents paired
  Impeccable and Taste Skill artifacts in equal isolated frames.

Success means the operator can move from source evidence to a concrete brief
and then to a controlled side-by-side comparison without losing provenance or
crossing the trusted application boundary.

## Positioning

The product joins local research records, canonical brief artifacts, and
engine-paired visual proofs in one workflow. Generation stays an explicit CLI
operation, so the web application can inspect results without owning model
credentials, agent processes, or queues.

## Operating Context

The application runs locally with Bun, React, Vite, strict TypeScript, and
SQLite. The browser is the trusted viewer and editor. Operator CLI commands
import the Taste Board, create comparison packets, and register generated
variants. SQLite stores live records; local capture, upload, and generated
artifact directories store files.

## Capabilities and Constraints

- Library supports search, filtering, detail inspection, manual create/edit,
  categories, provenance, evidence status, and copy actions.
- Briefs validates reusable output from `design-brief-grill` rather than
  duplicating the interview inside the application.
- Compare supports up to five directions, matched viewport controls, and
  separate Impeccable and Taste Skill artifacts.
- Generated pages are served from a separate origin with sandbox and CSP
  isolation from the trusted API.
- Automatic external-site browser capture is not part of the MVP. Operators may
  provide URLs, screenshots, media, and editable analysis fields.
- The trusted app/API and isolated variant origin may later move together into
  one LXC without changing the data model or workflow boundaries.

## Evidence on Hand

- `taste-board/` contains 18 normalized reference records and four provisional
  category seeds.
- The seed records preserve six captured, five partial, and seven blocked
  evidence states.
- `tests/fixtures/variants/` contains static variant fixtures for comparison and
  isolation checks.
- Project-local Impeccable, Taste, and `design-brief-grill` skills define the
  operator workflows. No commercial claims, customer proof, pricing, or
  deployment claims are established.

## Product Principles

- Preserve provenance and limitations instead of overstating thin evidence.
- Keep trusted data and untrusted generated artifacts on separate origins.
- Make generation explicit and operator-controlled through CLI registration.
- Keep SQLite and artifact boundaries portable from local use to one later LXC.
- Reuse the canonical grill skill instead of cloning its interview into the UI.
