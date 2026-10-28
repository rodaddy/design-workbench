import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { LocalAgentRunner } from "./agent-runner";
import { GenerationError, normalizeGeneratedManifest } from "./generation";
import { archiveOwnedPath, copyProjectSnapshot } from "./project-filesystem";
import type { StudioService } from "./studio";

/**
 * Refinement generation.
 *
 * A refinement branches from a *chosen proof*, not from the baseline: the whole
 * point of the stage is "keep this direction, explore three variations of it".
 * Parent artifacts are never mutated — each option is generated into its own
 * immutable directory so the lineage stays inspectable and a refinement can
 * always be compared against what it came from.
 */

/** The three refinement lenses, so options differ deliberately, not randomly. */
export const REFINEMENT_LENSES = [
  {
    slug: "option-1",
    title: "Restraint",
    instruction:
      "Push this direction toward restraint: reduce ornament, tighten the type scale, and let structure and spacing carry the design. Keep the same aesthetic family.",
  },
  {
    slug: "option-2",
    title: "Emphasis",
    instruction:
      "Push this direction toward emphasis: strengthen the focal hierarchy, increase scale contrast, and make the primary action unmistakable. Keep the same aesthetic family.",
  },
  {
    slug: "option-3",
    title: "Texture",
    instruction:
      "Push this direction toward material texture: develop surface, rule work, and detail so the page feels physically specific. Keep the same aesthetic family.",
  },
] as const;

export type RefinementLens = (typeof REFINEMENT_LENSES)[number];

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

export interface RefinementTarget {
  roundId: string;
  comparisonId: string;
  directionId: string;
  directionSlug: string;
  directionTitle: string;
  engine: "impeccable" | "taste";
  parentArtifactPath: string;
  position: number;
}

/**
 * Resolve which artifact a refinement round branches from. The round payload
 * records the selected direction; the engine is chosen explicitly by the
 * operator, defaulting to whichever proof exists.
 */
export function resolveRefinementParent(
  database: Database,
  roundId: string,
  preferredEngine?: "impeccable" | "taste",
): Omit<RefinementTarget, "position"> {
  const round = database
    .query<
      { id: string; comparison_id: string | null; payload: string },
      [string]
    >(
      `SELECT id, comparison_id, payload FROM exploration_rounds
       WHERE id = ? AND stage = 'refinement'`,
    )
    .get(roundId);
  if (!round || !round.comparison_id) {
    throw new GenerationError(
      "GENERATION_NOT_FOUND",
      "Refinement round does not exist or is not linked to a comparison",
    );
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(round.payload) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const directionId = payload.directionId;
  if (typeof directionId !== "string") {
    throw new GenerationError(
      "GENERATION_NOT_FOUND",
      "Refinement round does not record a selected direction",
    );
  }

  const direction = database
    .query<{ id: string; slug: string; title: string }, [string, string]>(
      `SELECT id, slug, title FROM aesthetic_directions
       WHERE comparison_id = ? AND id = ?`,
    )
    .get(round.comparison_id, directionId);
  if (!direction) {
    throw new GenerationError(
      "GENERATION_NOT_FOUND",
      "Selected direction does not exist",
    );
  }

  const variants = database
    .query<{ engine: "impeccable" | "taste"; artifact_path: string }, [string]>(
      `SELECT engine, artifact_path FROM variants
       WHERE direction_id = ? ORDER BY engine`,
    )
    .all(direction.id);
  if (variants.length === 0) {
    throw new GenerationError(
      "GENERATION_NOT_FOUND",
      "The selected direction has no registered proof to refine",
    );
  }
  const chosen =
    variants.find((variant) => variant.engine === preferredEngine) ??
    variants[0];
  if (!chosen) {
    throw new GenerationError(
      "GENERATION_NOT_FOUND",
      "No refinable proof is available for the selected direction",
    );
  }

  return {
    roundId: round.id,
    comparisonId: round.comparison_id,
    directionId: direction.id,
    directionSlug: direction.slug,
    directionTitle: direction.title,
    engine: chosen.engine,
    parentArtifactPath: chosen.artifact_path,
  };
}

/** Where one refinement option's artifact lives under the generated root. */
export function refinementArtifactPath(
  target: Omit<RefinementTarget, "position">,
  lens: RefinementLens,
): string {
  return [
    target.comparisonId,
    target.directionSlug,
    "refinements",
    lens.slug,
  ].join("/");
}

/**
 * Generate one refinement option. The parent proof is copied into a fresh
 * output directory and refined there, so the parent artifact is never edited
 * and the option can be compared against its own source.
 */
export async function generateRefinementOption(input: {
  database: Database;
  studio: StudioService;
  runner: LocalAgentRunner;
  generatedVariantsRoot: string;
  workbenchRoot: string;
  projectId: string;
  target: Omit<RefinementTarget, "position">;
  lens: RefinementLens;
  brief?: string;
  model?: string;
  effort?: "low" | "medium" | "high";
}): Promise<{ artifactPath: string }> {
  const generatedRoot = resolve(input.generatedVariantsRoot);
  const relativeOutput = refinementArtifactPath(input.target, input.lens);
  const output = resolve(generatedRoot, relativeOutput);
  if (!contained(generatedRoot, output)) {
    throw new GenerationError(
      "GENERATION_INVALID_PATH",
      "Refinement output escapes its configured root",
    );
  }
  const parent = resolve(generatedRoot, input.target.parentArtifactPath);
  if (!contained(generatedRoot, parent) || !existsSync(parent)) {
    throw new GenerationError(
      "GENERATION_NOT_FOUND",
      "Parent proof artifact is missing",
    );
  }

  // A non-empty cell means a previous attempt left output behind. Archive it
  // (never delete) so this attempt starts from a clean, owned directory.
  if (existsSync(output) && readdirSync(output).length > 0) {
    archiveOwnedPath(output, generatedRoot);
  }
  mkdirSync(output, { recursive: true });

  try {
    copyProjectSnapshot(parent, output);

    const skillName =
      input.target.engine === "impeccable"
        ? "impeccable"
        : "design-taste-frontend";
    const skillSource = resolve(
      input.workbenchRoot,
      ".claude",
      "skills",
      skillName,
    );
    const skillDestination = resolve(output, ".claude", "skills", skillName);
    if (!existsSync(skillDestination)) {
      copyProjectSnapshot(skillSource, skillDestination);
    }

    const operator =
      input.target.engine === "impeccable" ? "Impeccable" : "Taste Skill";
    const prompt = [
      `Refine the existing ${operator} design in this directory. It is already a chosen direction; do not restart it.`,
      `Direction: ${input.target.directionTitle}`,
      `Refinement lens — ${input.lens.title}: ${input.lens.instruction}`,
      "This directory is an isolated Design Workbench artifact copied from the chosen proof. Modify only this copy.",
      "Keep the run bounded: inspect only index.html and assets/site.css unless one directly referenced local asset is required.",
      "Make the visual changes within 15 tool calls. Edit the files directly; do not plan, delegate, launch commands, or narrate before editing.",
      input.brief ? `Source brief:\n${input.brief}` : "",
      "Preserve real content, links, accessibility, and responsive behavior.",
      "Keep index.html at this directory root and keep workbench.json valid.",
      "Do not deploy, contact external services, launch a browser, or edit the canonical source site.",
    ]
      .filter(Boolean)
      .join("\n");

    const session = input.studio.createSession(input.projectId, {
      roundId: input.target.roundId,
      metadata: {
        purpose: "refinement-generation",
        comparisonId: input.target.comparisonId,
        directionId: input.target.directionId,
        engine: input.target.engine,
        lens: input.lens.slug,
      },
      idempotencyKey: `refine-${input.target.roundId}-${input.lens.slug}`,
    });
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
        error: error instanceof Error ? error.message : "Refinement failed",
      });
      throw error;
    }

    if (!existsSync(resolve(output, "index.html"))) {
      throw new GenerationError(
        "GENERATION_OUTPUT_INVALID",
        "Local agent did not produce index.html",
      );
    }
    // Same contract as wide-net proofs: a refinement that cannot be served is
    // not a successful refinement.
    normalizeGeneratedManifest(output, relativeOutput);
    return { artifactPath: relativeOutput };
  } catch (error) {
    // Reset the workbench-owned cell so the next attempt starts clean.
    if (existsSync(output) && readdirSync(output).length > 0) {
      archiveOwnedPath(output, generatedRoot);
    }
    mkdirSync(output, { recursive: true });
    throw error;
  }
}
