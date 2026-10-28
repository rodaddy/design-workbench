# How Design Workbench was built

Sources: the private development repository's git history (19 commits,
2026-07-24 to 2026-10-27), its pull requests, the four SQL migrations, the
docs in `docs/`, and the 47 test files in this repository. The recorded
history starts part-way through the build: the first commit (2026-07-24) is
a fix to code that already existed, and most of the source tree was only
committed on 2026-09-11, when 251 uncommitted files were landed in one
reconciliation commit. Dates before 2026-07-24 are therefore not known from
the history and are not given here. This public repository is a one-commit
snapshot.

## The problem

Using AI tools to redesign a site produced options fast and lost the
reasoning just as fast: which reference inspired a page, what the brief
asked for, which engine made which proof, and why one direction won. The
aim was one local tool that keeps references, brief, generated proofs and
decisions linked, and compares engines fairly on the same brief.

## Timeline

| Date | What happened |
|------|---------------|
| before 2026-07-24 | The Library, Briefs, Studio and Compare pages, the API and migrations `0001`-`0002` already existed as uncommitted work: the July commits modify them, but they were only committed on 2026-09-11. |
| 2026-07-24 16:34 | **Manifest contract.** Generated proofs were registered without validating their tweak manifest, so a "successful" generation could produce a page the variant server refused to serve. Added a deterministic normaliser that maps the shapes real generators emit and rejects unsupported controls, validation before registration (a bad manifest fails the job and leaves a retryable cell), and a repair script that recovered all 16 controls on the two broken proofs. Generation model and effort became configuration. |
| 2026-07-24 16:34 | Ignored workbench-owned project snapshots after staging them pulled about 180 MB of third-party pages into the secret scan. |
| 2026-07-24 16:39 | **Job queue** (migration `0003_generation_jobs`). Long agent runs had been sitting behind long HTTP requests with no visible state, no cancel and no record. Added persisted jobs with a state machine, a partial unique index (retry allowed after failure, never two live jobs for one cell), atomic claim, cooperative cancel and recovery of orphaned jobs on startup. |
| 2026-07-24 16:43 | Compare shows the queue: one row per job with status, elapsed time, cancel and the failure text, replacing a spinner. |
| 2026-07-24 16:48 | **Refinements made real.** The stage had stored three placeholders and generated nothing. Each option now copies the chosen proof and refines the copy under one of three lenses (restraint, emphasis, texture), so options differ by intent and the parent is never mutated. Added a job runner outside the watch-mode dev server, because editing server code restarted it and killed in-flight agent runs. |
| 2026-07-24 16:53 | **Tweak decisions** (migration `0004_tweak_decisions`). Tweaks had been live-only. Decisions are now stored, re-validated against the current manifest on restore, and "apply" asks the agent to write them into a new immutable revision. |
| 2026-07-24 17:37-17:42 | Two fixes from real generator output: shorthand choice options (`["400","500"]`) are widened instead of discarding a whole proof, and number defaults are snapped onto their declared step (a 0.62 default on a 0.02 step from 0.35 cannot be reached). Out-of-range defaults still fail on purpose. |
| 2026-07-24 17:43-17:46 | Save, restore and apply from the tweak dock; a read-only handoff packet (JSON or Markdown) that records the source path and baseline hash and applies nothing. |
| 2026-09-11 | The full working tree (251 files) committed in one reconciliation commit. |
| 2026-09 to 2026-10 | Repository housekeeping only (agent instruction files, search index settings, secret-scanner change, removal of a retired runtime). |

## Key design decisions

- **Two origins.** The trusted app and the generated pages are served from
  different origins. Frames are sandboxed without same-origin access, the
  variant server sends a strict CSP, and operator decisions are only ever
  posted to the trusted origin, never to the generated page.
- **Immutable artifacts.** Source sites are copied into snapshots and never
  edited. Refinements and applied tweaks produce new directories, so the
  proof a decision was made against stays byte-identical.
- **Deterministic code around the AI step.** The agent writes pages; code
  validates, normalises, registers, queues and serves them. Normalisation
  repairs only shapes whose meaning is unambiguous (shorthand options,
  off-grid defaults) and refuses the rest rather than guessing.
- **Export, do not apply.** The handoff packet states its own scope. Writing
  a decision into the real site or deploying it stays a separate, explicit
  step.
- **"No manifest" is not "empty manifest".** The packet reports `null`
  controls for a proof without a manifest rather than zero, because they
  are different facts.

## How AI was used

Claude (Opus) wrote the code as a coding agent; every commit from
2026-07-24 carries its co-author line, and each commit message records the
defect it closes and why. The product itself is an AI orchestration layer:
it runs a local agent CLI with explicit arguments and bounded tools to
generate design proofs, and the fixes on 2026-07-24 came from that real
generator output failing the app's contracts.

## Testing

47 test files under `tests/` (backend, client and shared), run with
`bun test`, Testing Library and happy-dom: 239 tests, of which 230 pass on
a clean checkout, 1 is a todo, and 8 generation and refinement tests need
the third-party engine skills that are not shipped here. Commit messages
record defects the tests caught before release: a queue counter that
stalled below its concurrency cap when an executor threw synchronously, an
idle signal that fired while work was still queued, and revisions written
inside their parent directory that recursively copied themselves until the
path overflowed.

## What did not work

- **Blocking HTTP generation.** One long request per artifact gave no
  state, no cancel and no record; replaced by the persisted queue.
- **Running long jobs inside a watch-mode server.** Code edits restarted
  the server and killed agent runs; long rounds now drain in a separate
  runner, with `--retry-failed` archiving partial output.
- **Trusting generated manifests.** Real generator output failed the
  contract in several ways; the fix was a strict normaliser plus clearer
  instructions in the generation prompt, not looser serving.
- **Copy-to-clipboard as the only exit.** Tweak decisions were pasted by
  hand until they were persisted and applied through the app.

## Current state

Experimental and single-user. The code has not changed since 2026-07-24.
Writing a chosen result back to the source site and automated capture of
external sites remain unbuilt by design or deferred, as the README and
`docs/` state.
