# Local Source Sites

Design Workbench is intended to glam up locally owned site source without
depending on a production web server and without editing canonical source
during exploration.

## Current boundary

**The backend snapshot boundary is implemented; operator intake is planned.**

`StudioProjectStore` can be constructed with server-owned allowed source roots
and a workbench runtime root. It canonicalizes a requested source, rejects
traversal and symlink escape, copies a hashed baseline, persists project and
baseline records, and creates later baseline revisions. Backend tests exercise
that boundary.

The store is not constructed by the application server and has no API, CLI, or
UI route. No checked-in runtime configuration registers the two sites below.
The current operator-facing application therefore does not yet:

- register or list a source site as a Studio project;
- configure the production allowlist and Studio runtime root;
- request a baseline snapshot through an operator-facing path;
- launch an agent against that snapshot;
- write a selected result back to the source site.

Current comparison artifacts belong under `generated-variants/`. Canonical
site source remains outside that tree and must not be used as an engine output
directory.

## First local sources

| Site                     | Canonical local root                                                       | Baseline entry | Local authority                                                                    |
| ------------------------ | -------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| rTech Digital Consulting | `<dev-root>/rtech-consulting/site/rtech-consulting/` | `index.html`   | `site/rtech-consulting/README.md` and `DESIGN.md` in the owning repo               |
| Rico Rojas               | `<dev-root>/rtech-consulting/site/rico-rojas/`       | `index.html`   | `site/rico-rojas/README.md` and the owning repo policy; `recon/` is reference-only |

These paths are source references for the approved workflow. They are not
currently selectable project records in the Design Workbench UI, and this
documentation does not establish database records for them.

## Planned intake contract

The implemented store provides the core allowlist, canonicalization, copied
baseline, hashing, and persistence foundation. Completing project-backed Studio
intake still must:

1. accept only server-configured roots, never an arbitrary client path;
2. canonicalize the requested root and reject traversal, symlink escape, and
   paths outside the allowlist;
3. record the display name, local source root, entry page, and optional live URL
   as provenance only;
4. copy a read-only baseline into workbench-owned runtime storage;
5. run generation only in copied snapshots or generated-artifact directories;
6. record the baseline and every later immutable revision;
7. prove the original source tree stayed unchanged during exploration.

The optional live URL is not an input dependency. Intake and comparison must
work from local files even when the production site is unavailable.

## Preview expectations

Preview the canonical source with a loopback-only static server from the owning
repository. Do not use production as the baseline, and do not treat `file://`
behavior as equivalent to an HTTP preview when routes or absolute links are
involved.

Generated variants are previewed through Design Workbench’s separate variant
origin. Keep the trusted application origin and untrusted variant origin
separate; do not add `allow-same-origin` to proof frames.

## Ownership boundaries

| Location                    | Owner                        | Allowed role                         |
| --------------------------- | ---------------------------- | ------------------------------------ |
| Canonical site root         | `rtech-consulting` repo      | Read-only input during exploration   |
| Workbench baseline snapshot | Planned Studio runtime       | Immutable copied starting point      |
| `generated-variants/`       | Design Workbench runtime     | Engine output and registered proofs  |
| Production server           | Separate deployment workflow | Never an exploration input or target |

Any source-site edit, commit, push, deployment, DNS, Caddy, or SSH action needs
its own explicit scope and owning-repo checks. A selected Design Workbench proof
is evidence for that later change; it is not authorization to perform it.
