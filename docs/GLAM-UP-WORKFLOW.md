# Glam-Up Workflow

This guide maps the video-grounded design process onto Design Workbench without
claiming unfinished automation exists. It is the operator sequence for improving
an existing site while keeping source, generated proofs, and deployment
separate.

## Status legend

- **Implemented** means the current application or checked-in operator CLI
  performs the behavior.
- **Foundation implemented** means tested code or schema exists, but the
  behavior is not yet available through an operator-facing application path.
- **Manual** means the operator can complete the step with the current
  application plus an external installed agent or skill.
- **Planned** means the approved product direction defines the behavior, but the
  current application does not perform it.

## The complete process

### 1. Establish the baseline

**Foundation implemented; operator intake planned.**

The target Studio workflow starts from an allowlisted local source directory,
records its entry page, and copies a read-only baseline into workbench-owned
runtime storage. Exploration runs only against copied snapshots and generated
artifacts.

`StudioProjectStore` now implements the backend boundary for configured source
roots: it canonicalizes the source, rejects traversal and symlink escape, copies
a hashed baseline into workbench-owned runtime storage, and persists project
and baseline revisions. It is exercised directly by backend tests only. The
application server, API, CLI, and UI do not expose project registration, so
there is no current operator intake path or registered site project. Do not
describe a comparison as a source-site revision.

See [`LOCAL-SOURCE-SITES.md`](LOCAL-SOURCE-SITES.md).

### 2. Discuss Library evidence

**Library implemented; in-app discussion planned.**

Use Library to collect and inspect references, their design vocabulary, image
prompt, reusable brief notes, provenance, and evidence limitations. Choose only
qualities that can be observed and named.

The target workflow lets a local agent discuss the selected Library examples as
active context. That chat is not currently in the web application. Until it is,
hold the discussion with an installed agent outside Design Workbench and cite
the selected reference titles in the resulting brief.

Automatic external-site browser capture remains planned. Current Library
evidence comes from tracked seed data or operator-supplied local uploads.

### 3. Complete the four-part grill

**Implemented as an external operator skill; manual handoff to the app.**

Run `design-brief-grill` one focused question at a time. The four required parts
are:

1. aesthetic family and five to eight observable visual-vocabulary terms;
2. references, the exact qualities to borrow, and explicit copying boundaries;
3. intent, audience, desired feeling, and one primary action;
4. testable `Always` constants and `Never` bans, including accessibility and
   responsive behavior where relevant.

Resolve contradictions in the adversarial completeness pass. Save only the
distilled canonical Markdown artifact described in `briefs/README.md`; the app
does not conduct the interview itself.

### 4. Cast five directions

**Implemented, including automatic local generation and registration.**

Create a comparison with five ordered directions:

```sh
bun run comparison:new --brief briefs/<name>.md --directions 5
```

The command creates comparison records, a metadata packet, and empty output
directories for both engines. It does not call a model or run an agent. For a
Studio-linked comparison with local project storage and the local agent runner
configured, Compare can generate each engine proof into its assigned isolated
directory and register the completed artifact automatically.

Each direction should be meaningfully different while preserving the same
intent and guardrails. Ground it in an aesthetic family, selected
references/qualities, audience and primary action, plus `Always`/`Never`
constraints.

### 5. Compare Impeccable left and Taste right

**Implemented for individual directions and the five-direction overview.**

For each direction, use the in-app generation actions to run the local
Impeccable or Taste agent and register its artifact automatically. `Generate
all 10 locally` fills every missing engine slot in sequence. Copy-ready prompt
packets and `bun run variant:register` remain available for manual operation.

The current Compare workspace shows the selected direction as two equal proof
panes:

- Impeccable on the left;
- Taste on the right;
- one shared desktop, tablet, or mobile viewport;
- visible missing, rejected-path, loading, unavailable, and ready states;
- sandboxed frames on the separate variant origin.

### 6. Scan `ALL 5`

**Implemented.**

The Compare surface provides `V1`–`V5` selectors plus an explicit `ALL 5`
selector. `ALL 5` shows five direction rows by two engine columns—ten
proofs—with the shared viewport and visible per-proof states. Selecting a row
opens that direction’s detailed two-pane view.

### 7. Branch three refinements

**Implemented for direction selection and three-option branch creation.**

After choosing a direction, `Choose direction / Generate 3 refinements`
persists the direction selection and creates a child refinement round with
three option placeholders, then returns to Studio. The chosen direction,
brief, and previous proofs remain immutable.

The store, API, and Compare action record the parent-child lineage and the
three-option branch. Generating and reviewing the three refinement artifacts
remains later workflow work.

### 8. Explore assets

**Library evidence assets implemented; generated asset rounds planned.**

Library can store operator-supplied screenshots and media as evidence. The
target workflow goes further: generate multiple hero/image options for the
chosen refinement, select one, and use that asset while refining transitions
and motion.

The current application does not generate, compare, or select hero assets.
Never relabel a Library screenshot as a generated project asset.

### 9. Tune the selected proof

**Live tweak controls, Reset, and Copy decisions implemented.**

The detail view loads manifest-declared choice, number, color, and boolean
controls. Validated values apply live only to allowlisted CSS custom properties
inside the isolated proof. `Reset` restores manifest defaults, and `Copy
decisions for agent` copies the current decision values to the clipboard.

The variant server validates an adjacent versioned
`workbench.json`, injects a manifest-bound bridge, and accepts only validated
messages from a trusted parent origin for the matching variant. The bridge
updates declared CSS custom properties and suppresses motion-affecting
overrides under reduced motion.

Tweak snapshot persistence and agent-applied immutable artifact revisions
remain planned. A `tweak_snapshots` table exists as schema groundwork, but
snapshot storage logic and API behavior do not.

### 10. Produce the selected handoff

**Schema groundwork only; handoff planned.**

The target handoff identifies the chosen direction, refinement, asset, tweak
snapshot, immutable artifact revision, source baseline, and design-decision
history. It remains local and reviewable.

Project baselines, direction selections, and tweak snapshots have reserved
persistence shapes, but no current workflow assembles or exports this handoff.
Design Workbench does not write a selected result back to canonical site
source. Handoff, source integration, testing, commit, and deployment are
separate explicitly authorized work.

## Stop conditions

Stop and label the state honestly when:

- a reference is partial or blocked;
- a proof is missing or failed;
- a direction has not been selected;
- a later stage depends on planned automation;
- source-site modification or deployment would be required.

The correct outcome is a traceable local design decision, not a claim that an
unfinished pipeline ran.
