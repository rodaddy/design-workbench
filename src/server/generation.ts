import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  normalizeWorkbenchTweakManifest,
  WorkbenchManifestNormalizationError,
} from "../shared/tweaks";
import type { LocalAgentRunner } from "./agent-runner";
import {
  archiveOwnedPath,
  copyProjectSnapshot,
  ownedPath,
} from "./project-filesystem";
import type { StudioProjectStore } from "./projects";
import type { StudioService } from "./studio";
import { registerVariant } from "./variants";

/**
 * Active generations keyed by comparison + direction + engine/output. Only one
 * generation may own a given generated-output cell at a time; overlapping
 * requests are rejected with the stable GENERATION_CONFLICT / 409 contract.
 */
const activeGenerations = new Set<string>();

/**
 * The generator-facing contract for `workbench.json`. Earlier runs invented
 * `tweaks`/`cssCustomProperty`/`value` and unsupported `length` controls, which
 * produced registered-but-unservable proofs. Stating the exact supported shape
 * (and that `length` is not one of them) is cheaper than normalizing guesses.
 */
const MANIFEST_INSTRUCTION = [
  "Write a workbench.json tweak manifest at this directory root describing the CSS custom properties an operator may safely adjust.",
  'Use exactly this shape: {"version":1,"controls":[...]}.',
  "Every control needs: id (lowercase kebab-case), label, property (a --custom-property the stylesheet actually reads), type, and default.",
  'Supported types are only "choice", "number", "color", and "boolean".',
  'There is no "length" type: express spacing, radius, and size as type "number" with min, max, step, and unit (one of "", px, rem, em, %, deg, ms, s).',
  'Colors must be 6- or 8-digit hex. Set "affectsMotion": true on any control that drives animation.',
  'Example control: {"id":"page-margin","label":"Page margin","property":"--page-margin","type":"number","min":1,"max":4,"step":0.25,"unit":"rem","default":2}.',
  'A "choice" control lists options as objects, never bare strings, and its default must equal one of the option values: {"id":"display-weight","label":"Display weight","property":"--display-weight","type":"choice","options":[{"label":"Regular","value":"400"},{"label":"Semibold","value":"600"}],"default":"600"}.',
  "The stylesheet must actually consume each declared property so the control has a visible effect.",
].join(" ");

export class GenerationError extends Error {
  constructor(
    readonly code:
      | "GENERATION_CONFLICT"
      | "GENERATION_INVALID_PATH"
      | "GENERATION_NOT_FOUND"
      | "GENERATION_OUTPUT_INVALID",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GenerationError";
  }
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

export async function generateComparisonVariant(input: {
  database: Database;
  projects: StudioProjectStore;
  studio: StudioService;
  runner: LocalAgentRunner;
  projectRuntimeRoot: string;
  generatedVariantsRoot: string;
  workbenchRoot: string;
  comparisonId: string;
  directionId: string;
  engine: "impeccable" | "taste";
  model?: string;
  effort?: "low" | "medium" | "high";
}) {
  const round = input.database
    .query<{ id: string; project_id: string; prompt: string }, [string]>(
      `SELECT id, project_id, prompt FROM exploration_rounds
       WHERE comparison_id = ? ORDER BY sequence DESC LIMIT 1`,
    )
    .get(input.comparisonId);
  if (!round) {
    throw new GenerationError(
      "GENERATION_NOT_FOUND",
      "Comparison is not linked to a Studio round",
    );
  }
  const project = input.projects.getProject(round.project_id);
  const baseline = project.baselines.at(-1);
  if (!baseline) {
    throw new GenerationError(
      "GENERATION_NOT_FOUND",
      "Project baseline is missing",
    );
  }
  const direction = input.database
    .query<
      { id: string; slug: string; title: string; metadata: string },
      [string, string, string]
    >(
      `SELECT id, slug, title, metadata FROM aesthetic_directions
       WHERE comparison_id = ? AND (id = ? OR slug = ?) LIMIT 1`,
    )
    .get(input.comparisonId, input.directionId, input.directionId);
  if (!direction) {
    throw new GenerationError(
      "GENERATION_NOT_FOUND",
      "Direction does not exist",
    );
  }
  const generatedRoot = resolve(input.generatedVariantsRoot);
  const output = resolve(
    generatedRoot,
    input.comparisonId,
    direction.slug,
    input.engine,
  );
  if (!contained(generatedRoot, output)) {
    throw new GenerationError(
      "GENERATION_INVALID_PATH",
      "Generated output escapes its configured root",
    );
  }

  // One active generation per comparison + direction + engine/output. Overlap
  // is rejected with the stable GENERATION_CONFLICT / 409 contract, and the
  // owning cell is released in the finally so a rejected attempt never leaks
  // the lock.
  const cellKey = JSON.stringify([
    input.comparisonId,
    direction.id,
    input.engine,
  ]);
  if (activeGenerations.has(cellKey)) {
    throw new GenerationError(
      "GENERATION_CONFLICT",
      "A generation is already running for this comparison, direction, and engine",
    );
  }
  activeGenerations.add(cellKey);
  try {
    if (!existsSync(output)) {
      throw new GenerationError(
        "GENERATION_NOT_FOUND",
        "Generated output directory was not prepared",
      );
    }
    if (readdirSync(output).length > 0) {
      throw new GenerationError(
        "GENERATION_CONFLICT",
        "Generated output directory is not empty",
      );
    }

    // From here the workbench owns partial output under `output`. Any failure
    // must archive that partial output (never the canonical source, never a
    // raw rm) so the next attempt sees a prepared, empty cell and can succeed.
    return await generateIntoPreparedOutput({
      input,
      round,
      project,
      baseline,
      direction,
      generatedRoot,
      output,
    });
  } finally {
    activeGenerations.delete(cellKey);
  }
}

async function generateIntoPreparedOutput(context: {
  input: {
    database: Database;
    studio: StudioService;
    runner: LocalAgentRunner;
    projectRuntimeRoot: string;
    workbenchRoot: string;
    comparisonId: string;
    engine: "impeccable" | "taste";
    model?: string;
    effort?: "low" | "medium" | "high";
  };
  round: { id: string; prompt: string };
  project: { id: string };
  baseline: { snapshotPath: string };
  direction: { id: string; title: string; metadata: string };
  generatedRoot: string;
  output: string;
}) {
  const { input, round, project, baseline, direction, generatedRoot, output } =
    context;
  try {
    const baselineRoot = ownedPath(
      input.projectRuntimeRoot,
      baseline.snapshotPath,
    );
    copyProjectSnapshot(baselineRoot, output);
    const skillName =
      input.engine === "impeccable" ? "impeccable" : "design-taste-frontend";
    const skillSource = resolve(
      input.workbenchRoot,
      ".claude",
      "skills",
      skillName,
    );
    const skillDestination = resolve(output, ".claude", "skills", skillName);
    copyProjectSnapshot(skillSource, skillDestination);

    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(direction.metadata) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    const session = input.studio.createSession(project.id, {
      roundId: round.id,
      metadata: {
        purpose: "variant-generation",
        comparisonId: input.comparisonId,
        directionId: direction.id,
        engine: input.engine,
      },
      idempotencyKey: `generate-${input.comparisonId}-${direction.id}-${input.engine}`,
    });
    const operator =
      input.engine === "impeccable" ? "Impeccable" : "Taste Skill";
    const skillInstruction =
      input.engine === "impeccable"
        ? "Read .claude/skills/impeccable/SKILL.md and .claude/skills/impeccable/reference/craft-floor.md directly, then apply their design guidance. Do not invoke the /impeccable command, context.mjs, setup, concept selection, or subagents."
        : "Read .claude/skills/design-taste-frontend/SKILL.md directly, then apply its anti-slop redesign and preflight guidance. Do not invoke the /design-taste-frontend command, setup, or subagents.";
    const prompt = [
      `Use the locally installed ${operator} design guidance to glam up the copied site in this directory.`,
      skillInstruction,
      "This directory is an isolated Design Workbench artifact. Modify only this copy.",
      "Keep the run bounded: inspect only index.html, assets/site.css, and the named skill files unless one directly referenced local asset is required. Do not inventory the whole site.",
      "Make the visual changes within 15 tool calls. Edit the files directly; do not plan, delegate, launch commands, or narrate before editing.",
      `Direction: ${direction.title}`,
      `Aesthetic family: ${String(metadata.aestheticFamily ?? direction.title)}`,
      round.prompt ? `Round instruction: ${round.prompt}` : "",
      "Preserve real content, links, accessibility, and responsive behavior from the baseline.",
      "Produce a complete static site with index.html at this directory root.",
      MANIFEST_INSTRUCTION,
      "Do not deploy, contact external services, launch a browser, or edit the canonical source site.",
    ]
      .filter(Boolean)
      .join("\n");
    const run = input.studio.startRun(session.id, prompt);
    try {
      const result = await input.runner.run({
        sessionId: crypto.randomUUID(),
        prompt,
        cwd: output,
        mode: "build",
        resume: false,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
      });
      input.studio.finishRun(session.id, run.runId, { text: result.text });
    } catch (error) {
      input.studio.finishRun(session.id, run.runId, {
        error: error instanceof Error ? error.message : "Generation failed",
      });
      throw error;
    }

    if (!existsSync(resolve(output, "index.html"))) {
      throw new GenerationError(
        "GENERATION_OUTPUT_INVALID",
        "Local agent did not produce index.html",
      );
    }

    // A successful generation must never register a variant the variant server
    // will refuse to serve. Normalize the generated manifest against the
    // authoritative schema and rewrite it in canonical form before
    // registration; an unfixable manifest fails the generation so the cell is
    // archived and retryable rather than becoming a registered dead proof.
    normalizeGeneratedManifest(
      output,
      relative(generatedRoot, output).split(sep).join("/"),
    );

    return registerVariant(input.database, {
      comparison: input.comparisonId,
      direction: direction.id,
      engine: input.engine,
      path: output,
      generatedRoot,
      metadata: {
        generator: "local-claude-code",
        studioProjectId: project.id,
        studioRoundId: round.id,
        // Requested routing is operator-recorded provenance. It is not an
        // attestation that the CLI actually served this model.
        requestedModel: input.model ?? "default",
        requestedEffort: input.effort ?? "default",
      },
      viewport: { width: 1440, height: 900 },
    });
  } catch (error) {
    // Reset only the workbench-owned partial output so the prepared, empty cell
    // is restored for the next attempt. archiveOwnedPath refuses anything not
    // contained in the generated root and moves it into `_archive` (never rm),
    // then we recreate the empty cell the next attempt expects.
    resetPartialOutput(generatedRoot, output);
    throw error;
  }
}

/**
 * Validate and canonicalize the generated `workbench.json`, if the agent wrote
 * one. A missing manifest is allowed: the variant simply serves without tweak
 * controls. A present-but-invalid manifest is a generation failure, because
 * registering it would produce a proof the variant server answers with 500.
 */
export function normalizeGeneratedManifest(
  output: string,
  variantId: string,
): void {
  const manifestPath = resolve(output, "workbench.json");
  if (!existsSync(manifestPath)) return;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new GenerationError(
      "GENERATION_OUTPUT_INVALID",
      "Generated workbench.json is not valid JSON",
      { cause: error },
    );
  }

  try {
    const manifest = normalizeWorkbenchTweakManifest(raw, variantId);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    if (error instanceof WorkbenchManifestNormalizationError) {
      throw new GenerationError(
        "GENERATION_OUTPUT_INVALID",
        `Generated workbench.json is invalid: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function resetPartialOutput(generatedRoot: string, output: string): void {
  archiveOwnedPath(output, generatedRoot);
  ownedPath(generatedRoot, relative(generatedRoot, output));
  mkdirSync(output, { recursive: true });
}
