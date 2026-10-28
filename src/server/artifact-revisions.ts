import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { LocalAgentRunner } from "./agent-runner";
import { GenerationError, normalizeGeneratedManifest } from "./generation";
import { archiveOwnedPath, copyProjectSnapshot } from "./project-filesystem";
import type { StudioService } from "./studio";
import {
  loadVariantManifest,
  TweakDecisionError,
  type TweakDecisionSet,
} from "./tweak-decisions";
import type { WorkbenchTweakControl } from "../shared/tweaks";

/**
 * Agent-applied tweak revisions.
 *
 * Tweaks applied live in the browser are inline style overrides on the variant
 * document; they vanish on reload and never reach the stylesheet. Asking the
 * agent to "apply" them means writing the chosen values into the artifact's own
 * CSS. That is done into a NEW artifact directory: the proof the operator
 * compared against stays byte-identical, so a revision can always be judged
 * against what it came from.
 */

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

/** Render one decision as the CSS declaration the stylesheet should carry. */
export function declarationFor(
  control: WorkbenchTweakControl,
  value: boolean | number | string,
): string {
  if (control.type === "number")
    return `${control.property}: ${value}${control.unit};`;
  if (control.type === "boolean")
    return `${control.property}: ${value ? "1" : "0"};`;
  return `${control.property}: ${value};`;
}

export interface ArtifactRevision {
  id: string;
  projectId: string;
  parentVariantId: string;
  parentArtifactPath: string;
  artifactPath: string;
  decisionId: string | null;
  sequence: number;
  status: "pending" | "completed" | "failed";
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

type RevisionRow = {
  id: string;
  project_id: string;
  parent_variant_id: string;
  parent_artifact_path: string;
  artifact_path: string;
  decision_id: string | null;
  sequence: number;
  status: ArtifactRevision["status"];
  error: string | null;
  created_at: string;
  updated_at: string;
};

function toRevision(row: RevisionRow): ArtifactRevision {
  return {
    id: row.id,
    projectId: row.project_id,
    parentVariantId: row.parent_variant_id,
    parentArtifactPath: row.parent_artifact_path,
    artifactPath: row.artifact_path,
    decisionId: row.decision_id,
    sequence: row.sequence,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listRevisions(
  database: Database,
  parentVariantId: string,
): ArtifactRevision[] {
  return database
    .query<RevisionRow, [string]>(
      `SELECT * FROM artifact_revisions WHERE parent_variant_id = ?
       ORDER BY sequence`,
    )
    .all(parentVariantId)
    .map(toRevision);
}

/**
 * Apply a saved decision set into a new immutable artifact revision by asking
 * the local agent to write the values into the artifact's stylesheet.
 */
export async function applyTweakRevision(input: {
  database: Database;
  studio: StudioService;
  runner: LocalAgentRunner;
  generatedVariantsRoot: string;
  workbenchRoot: string;
  decisionSet: TweakDecisionSet;
  model?: string;
  effort?: "low" | "medium" | "high";
}): Promise<ArtifactRevision> {
  const generatedRoot = resolve(input.generatedVariantsRoot);
  const parent = resolve(generatedRoot, input.decisionSet.artifactPath);
  if (!contained(generatedRoot, parent) || !existsSync(parent)) {
    throw new GenerationError(
      "GENERATION_NOT_FOUND",
      "Parent artifact is missing",
    );
  }
  if (Object.keys(input.decisionSet.decisions).length === 0) {
    throw new TweakDecisionError(
      "TWEAK_INVALID_INPUT",
      "There are no tweak decisions to apply",
    );
  }

  const manifest = loadVariantManifest(
    generatedRoot,
    input.decisionSet.artifactPath,
  );
  const byId = new Map(manifest.controls.map((c) => [c.id, c]));

  const sequence =
    (input.database
      .query<{ value: number | null }, [string]>(
        `SELECT MAX(sequence) AS value FROM artifact_revisions
         WHERE parent_variant_id = ?`,
      )
      .get(input.decisionSet.variantId)?.value ?? 0) + 1;
  // Revisions are siblings of the proof, never children of it. Nesting them
  // inside the parent directory would make each revision copy the previous
  // one's revisions too, growing the tree until the path overflows. The prefix
  // stays within the variant-id pattern so the revision is directly servable.
  const relativeOutput = `revisions/${input.decisionSet.variantId}/r${sequence}`;
  const output = resolve(generatedRoot, relativeOutput);
  if (!contained(generatedRoot, output)) {
    throw new GenerationError(
      "GENERATION_INVALID_PATH",
      "Revision output escapes its configured root",
    );
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  input.database
    .query(
      `INSERT INTO artifact_revisions (
        id, project_id, parent_variant_id, parent_artifact_path, artifact_path,
        decision_id, sequence, status, idempotency_key, request_fingerprint,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.decisionSet.projectId,
      input.decisionSet.variantId,
      input.decisionSet.artifactPath,
      relativeOutput,
      input.decisionSet.id,
      sequence,
      `revision-${input.decisionSet.id}-${sequence}`,
      id,
      now,
      now,
    );

  const fail = (message: string): never => {
    input.database
      .query(
        `UPDATE artifact_revisions
         SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        message.slice(0, 20_000) || "Revision failed",
        new Date().toISOString(),
        id,
      );
    throw new GenerationError("GENERATION_OUTPUT_INVALID", message);
  };

  try {
    // A revision cell is only ever written by this function; an existing
    // non-empty one is leftover partial output and is archived, never deleted.
    if (existsSync(output) && readdirSync(output).length > 0) {
      archiveOwnedPath(output, generatedRoot);
    }
    mkdirSync(output, { recursive: true });
    copyProjectSnapshot(parent, output);

    const declarations = Object.entries(input.decisionSet.decisions)
      .map(([controlId, value]) => {
        const control = byId.get(controlId);
        return control ? `  ${declarationFor(control, value)}` : null;
      })
      .filter((line): line is string => line !== null);
    if (declarations.length === 0) {
      fail("No decision matches a control in the artifact's manifest");
    }

    const prompt = [
      "Apply these confirmed visual decisions permanently into this copied site's stylesheet.",
      "The values below are already the operator's chosen result. Do not reinterpret, improve, or redesign them.",
      "Set exactly these CSS custom properties at the stylesheet's :root (or existing equivalent) so they are the new defaults:",
      "",
      ...declarations,
      "",
      "Edit assets/site.css (or whichever stylesheet already declares these properties) directly.",
      "Update workbench.json so each control's default matches the value you just wrote.",
      "Change nothing else: no layout, copy, structural, or unrelated style changes.",
      "Keep index.html at this directory root. Preserve accessibility and reduced-motion behavior.",
      "Do not deploy, contact external services, launch a browser, or edit the canonical source site.",
    ].join("\n");

    const session = input.studio.createSession(input.decisionSet.projectId, {
      roundId: null,
      metadata: {
        purpose: "tweak-revision",
        parentVariantId: input.decisionSet.variantId,
        decisionId: input.decisionSet.id,
        sequence,
      },
      idempotencyKey: `revision-${input.decisionSet.id}-${sequence}`,
    });
    const run = input.studio.startRun(session.id, prompt);
    input.database
      .query(
        `UPDATE artifact_revisions SET session_id = ?, run_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(session.id, run.runId, new Date().toISOString(), id);

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
        error: error instanceof Error ? error.message : "Revision failed",
      });
      throw error;
    }

    if (!existsSync(resolve(output, "index.html"))) {
      fail("Local agent did not produce index.html");
    }
    normalizeGeneratedManifest(output, relativeOutput);

    input.database
      .query(
        `UPDATE artifact_revisions
         SET status = 'completed', error = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), id);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Revision generation failed";
    input.database
      .query(
        `UPDATE artifact_revisions
         SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(message.slice(0, 20_000), new Date().toISOString(), id);
    if (existsSync(output) && readdirSync(output).length > 0) {
      archiveOwnedPath(output, generatedRoot);
    }
    throw error;
  }

  const row = input.database
    .query<RevisionRow, [string]>(
      "SELECT * FROM artifact_revisions WHERE id = ?",
    )
    .get(id);
  if (!row) {
    throw new GenerationError(
      "GENERATION_OUTPUT_INVALID",
      "Revision did not persist",
    );
  }
  return toRevision(row);
}
