# Compare And Refine

Compare is the proofing surface between a canonical brief and a selected design
handoff. Its five-direction comparison, `ALL 5` overview, automatic local
generation and registration, three-option refinement branch, and constrained
live tweak controls are implemented. Refinement artifact review, asset rounds,
persisted tweak snapshots, immutable agent-applied revisions, selected handoff,
and external automated capture remain planned.

## Current comparison

**Implemented.**

A comparison contains one to five ordered aesthetic directions. Each direction
has two engine positions:

| Column | Engine      | Current operation                                                                   |
| ------ | ----------- | ----------------------------------------------------------------------------------- |
| Left   | Impeccable  | Generate and register locally in-app, or use the manual copy-and-register fallback. |
| Right  | Taste Skill | Generate and register locally in-app, or use the manual copy-and-register fallback. |

The selected-direction view provides:

- equal Impeccable and Taste proof panes;
- one shared desktop, tablet, or mobile viewport;
- direction tabs with keyboard navigation;
- visible missing, rejected-path, loading, unavailable, and ready states;
- prompt packets containing the brief, exact output directory, and registration
  command;
- source brief and direction metadata inspection;
- sandboxed iframes on the isolated variant origin without
  `allow-same-origin`.

For Studio-linked comparisons with local project storage and the local agent
runner configured, Compare automatically generates and registers one proof or
all missing proofs through the local generation API. `comparison:new` still
only creates rows, metadata, and empty directories; copy-ready prompts and
`variant:register` remain the manual path.

External automated browser capture remains planned and is not part of
comparison generation. Current references must already exist in Library as
tracked evidence or operator-supplied local uploads.

## Five directions and `ALL 5`

**Implemented.**

The top register contains `V1` through `V5` plus an explicit `ALL 5`
selector. Direction labels should expose a useful title and aesthetic family
rather than only a number.

The `ALL 5` contact sheet provides:

- five rows, one per aesthetic direction;
- two fixed columns, Impeccable left and Taste right;
- ten independently visible proof states;
- one shared viewport;
- a click or keyboard action that opens the chosen direction in the current
  detailed two-pane view.

## Three refinements

**Direction selection and three-option branching implemented.**

Choosing one of the five directions through `Choose direction / Generate 3
refinements` persists the selection and creates a child refinement round with
three option placeholders. The parent direction and first-pass proofs remain
immutable.

The Studio store, API, and Compare action record the stage, selected parent
direction, three child options, selection receipt, and transitive round lineage.
Generation and review of the three refinement artifacts are still planned.

## Asset round

**Planned.**

After a refinement is selected, an asset round can contain multiple hero or
image options associated with that proof. The operator chooses an asset before
motion and transition tuning.

Library evidence uploads already exist, but they are not project asset options.
Keep provenance screenshots, generated assets, and final selected assets
distinct.

## Tweak manifests

**Manifest, isolated bridge, live controls, Reset, and Copy decisions
implemented.**

The target tweak bar controls typography, color, imagery, motion, weight, reveal
behavior, and related design decisions through a versioned
`workbench.json` manifest.

The implemented behavior:

- the artifact declares allowed CSS custom properties, control types, labels,
  defaults, and valid ranges or values;
- the trusted parent sends validated messages to the selected isolated proof;
- the child verifies parent origin, variant identity, property allowlist, and
  value schema;
- arbitrary JavaScript, selectors, HTML, and unrestricted CSS are rejected;
- motion-affecting overrides are suppressed while reduced motion is active.
- the detailed Compare view renders manifest-declared choice, number, color,
  and boolean controls and applies valid changes live;
- `Reset` restores every control to its manifest default;
- `Copy decisions for agent` copies the current values to the clipboard.

The server injects the bridge only when the selected artifact has a valid
adjacent manifest.

Still planned:

- persistence logic and APIs for the reserved `tweak_snapshots` table;
- agent-applied immutable artifact revisions produced from copied decisions;
- a visible revision and decision history.

## Selected handoff

**Schema groundwork only; handoff planned.**

A complete handoff should identify:

- source project and immutable baseline;
- canonical brief and selected Library evidence;
- chosen first-pass direction;
- chosen refinement;
- chosen asset;
- persisted tweak snapshot;
- final immutable artifact revision;
- unresolved risks and verification evidence.

The handoff is not a deployment. Applying it to canonical source, testing that
source, committing, pushing, and deploying remain separate owning-repository
work.
