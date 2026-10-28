import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { workbenchTweakManifestSchema } from "../shared/tweaks";

/**
 * Handoff export.
 *
 * The packet is a read-only summary of what the operator decided: the brief
 * and its source reference, the project and the canonical source path the work
 * was derived from, every proof and refinement produced, the tweak decisions
 * saved against them, and the revisions an agent applied.
 *
 * It deliberately does not apply anything. Writing these decisions into the
 * canonical site, deploying, or touching production are separately authorized
 * actions; a packet that performed them would make an export indistinguishable
 * from a release. What it produces is the evidence someone needs to make that
 * call, including the paths and content hashes to verify canonical source was
 * never modified during exploration.
 */

export class HandoffError extends Error {
  constructor(
    readonly code: "HANDOFF_NOT_FOUND" | "HANDOFF_DATA_INVALID",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HandoffError";
  }
}

export interface HandoffArtifact {
  readonly variantId: string;
  readonly directionTitle: string;
  readonly directionSlug: string;
  readonly engine: string;
  readonly artifactPath: string;
  readonly stage: string;
  /** Controls the operator could adjust, or null when the proof has no manifest. */
  readonly tweakControls: number | null;
  readonly createdAt: string;
}

export interface HandoffDecisionSet {
  readonly id: string;
  readonly label: string;
  readonly variantId: string;
  readonly artifactPath: string;
  readonly decisions: Record<string, boolean | number | string>;
  readonly createdAt: string;
}

export interface HandoffRevision {
  readonly id: string;
  readonly parentArtifactPath: string;
  readonly artifactPath: string;
  readonly sequence: number;
  readonly status: string;
  readonly createdAt: string;
}

export interface HandoffPacket {
  readonly version: 1;
  readonly project: {
    readonly id: string;
    readonly slug: string;
    readonly title: string;
    /**
     * Recorded so a reviewer can confirm the canonical site is the one this
     * work was derived from. Exploration never writes here.
     */
    readonly canonicalSourcePath: string;
    readonly baseline: {
      readonly revision: number;
      readonly contentHash: string;
      readonly fileCount: number;
      readonly byteCount: number;
    } | null;
  };
  readonly brief: {
    readonly id: string;
    readonly title: string;
    readonly sourceInspirationId: string | null;
    readonly markdown: string;
  } | null;
  readonly rounds: readonly {
    readonly id: string;
    readonly sequence: number;
    readonly stage: string;
    readonly status: string;
  }[];
  readonly selectedDirection: {
    readonly title: string;
    readonly rationale: string;
    readonly directionKey: string;
  } | null;
  readonly artifacts: readonly HandoffArtifact[];
  readonly decisions: readonly HandoffDecisionSet[];
  readonly revisions: readonly HandoffRevision[];
  readonly notApplied: readonly string[];
  readonly generatedAt: string;
}

/**
 * Count the controls a proof exposes. A proof whose manifest is missing or
 * unreadable reports null rather than zero: "no manifest" and "a manifest
 * offering nothing" are different facts and a reviewer should see which.
 */
function tweakControlCount(
  generatedVariantsRoot: string,
  artifactPath: string,
): number | null {
  const manifestPath = resolve(
    generatedVariantsRoot,
    artifactPath,
    "workbench.json",
  );
  if (!existsSync(manifestPath)) return null;
  try {
    return workbenchTweakManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    ).controls.length;
  } catch {
    return null;
  }
}

export function buildHandoffPacket(input: {
  database: Database;
  generatedVariantsRoot: string;
  projectId: string;
  generatedAt: string;
}): HandoffPacket {
  const { database, projectId } = input;

  const project = database
    .query<
      {
        id: string;
        slug: string;
        title: string;
        canonical_source_path: string;
      },
      [string]
    >(
      `SELECT id, slug, title, canonical_source_path FROM site_projects
       WHERE id = ?`,
    )
    .get(projectId);
  if (!project) {
    throw new HandoffError("HANDOFF_NOT_FOUND", "Site project does not exist");
  }

  const baseline = database
    .query<
      {
        revision: number;
        content_hash: string;
        file_count: number;
        byte_count: number;
      },
      [string]
    >(
      `SELECT revision, content_hash, file_count, byte_count FROM project_baselines
       WHERE project_id = ? ORDER BY revision DESC LIMIT 1`,
    )
    .get(projectId);

  const rounds = database
    .query<
      {
        id: string;
        sequence: number;
        stage: string;
        status: string;
        comparison_id: string | null;
      },
      [string]
    >(
      `SELECT id, sequence, stage, status, comparison_id FROM exploration_rounds
       WHERE project_id = ? ORDER BY sequence`,
    )
    .all(projectId);

  // The brief is reached through the comparison the first round explores, so a
  // project explored without a brief still exports cleanly.
  const brief = database
    .query<
      {
        id: string;
        title: string;
        source_inspiration_id: string | null;
        markdown: string;
      },
      [string]
    >(
      `SELECT b.id, b.title, b.source_inspiration_id, b.markdown
       FROM briefs AS b
       JOIN comparisons AS c ON c.source_brief_id = b.id
       JOIN exploration_rounds AS r ON r.comparison_id = c.id
       WHERE r.project_id = ?
       ORDER BY r.sequence LIMIT 1`,
    )
    .get(projectId);

  const selection = database
    .query<
      { title: string; rationale: string; direction_key: string },
      [string]
    >(
      `SELECT title, rationale, direction_key FROM direction_selections
       WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(projectId);

  const artifacts = database
    .query<
      {
        id: string;
        direction_title: string;
        direction_slug: string;
        engine: string;
        artifact_path: string;
        stage: string;
        created_at: string;
      },
      [string]
    >(
      `SELECT v.id, d.title AS direction_title, d.slug AS direction_slug,
              v.engine, v.artifact_path, r.stage, v.created_at
       FROM variants AS v
       JOIN aesthetic_directions AS d ON d.id = v.direction_id
       JOIN exploration_rounds AS r ON r.comparison_id = d.comparison_id
       WHERE r.project_id = ?
       ORDER BY d.position, v.engine`,
    )
    .all(projectId);

  const decisions = database
    .query<
      {
        id: string;
        label: string;
        variant_id: string;
        artifact_path: string;
        decisions: string;
        created_at: string;
      },
      [string]
    >(
      `SELECT id, label, variant_id, artifact_path, decisions, created_at
       FROM tweak_decisions WHERE project_id = ? ORDER BY created_at`,
    )
    .all(projectId);

  const revisions = database
    .query<
      {
        id: string;
        parent_artifact_path: string;
        artifact_path: string;
        sequence: number;
        status: string;
        created_at: string;
      },
      [string]
    >(
      `SELECT id, parent_artifact_path, artifact_path, sequence, status, created_at
       FROM artifact_revisions WHERE project_id = ? ORDER BY created_at`,
    )
    .all(projectId);

  return {
    version: 1,
    project: {
      id: project.id,
      slug: project.slug,
      title: project.title,
      canonicalSourcePath: project.canonical_source_path,
      baseline: baseline
        ? {
            revision: baseline.revision,
            contentHash: baseline.content_hash,
            fileCount: baseline.file_count,
            byteCount: baseline.byte_count,
          }
        : null,
    },
    brief: brief
      ? {
          id: brief.id,
          title: brief.title,
          sourceInspirationId: brief.source_inspiration_id,
          markdown: brief.markdown,
        }
      : null,
    rounds: rounds.map((round) => ({
      id: round.id,
      sequence: round.sequence,
      stage: round.stage,
      status: round.status,
    })),
    selectedDirection: selection
      ? {
          title: selection.title,
          rationale: selection.rationale,
          directionKey: selection.direction_key,
        }
      : null,
    artifacts: artifacts.map((artifact) => ({
      variantId: artifact.id,
      directionTitle: artifact.direction_title,
      directionSlug: artifact.direction_slug,
      engine: artifact.engine,
      artifactPath: artifact.artifact_path,
      stage: artifact.stage,
      tweakControls: tweakControlCount(
        input.generatedVariantsRoot,
        artifact.artifact_path,
      ),
      createdAt: artifact.created_at,
    })),
    decisions: decisions.map((row) => {
      let parsed: Record<string, boolean | number | string>;
      try {
        parsed = JSON.parse(row.decisions) as Record<
          string,
          boolean | number | string
        >;
      } catch (error) {
        throw new HandoffError(
          "HANDOFF_DATA_INVALID",
          `Tweak decisions for '${row.id}' are not readable`,
          { cause: error },
        );
      }
      return {
        id: row.id,
        label: row.label,
        variantId: row.variant_id,
        artifactPath: row.artifact_path,
        decisions: parsed,
        createdAt: row.created_at,
      };
    }),
    revisions: revisions.map((row) => ({
      id: row.id,
      parentArtifactPath: row.parent_artifact_path,
      artifactPath: row.artifact_path,
      sequence: row.sequence,
      status: row.status,
      createdAt: row.created_at,
    })),
    // Stated in the packet itself so a reader never has to infer how far the
    // export went.
    notApplied: [
      "The canonical source site has not been modified.",
      "Nothing has been deployed and no production system was contacted.",
      "Applying these decisions to canonical source requires separate authorization.",
    ],
    generatedAt: input.generatedAt,
  };
}

/** Render the packet as the Markdown a reviewer reads. */
export function renderHandoffMarkdown(packet: HandoffPacket): string {
  const lines: string[] = [
    `# Handoff packet — ${packet.project.title}`,
    "",
    `Generated ${packet.generatedAt}`,
    "",
    "## Scope",
    "",
    ...packet.notApplied.map((statement) => `- ${statement}`),
    "",
    "## Project",
    "",
    `- Slug: \`${packet.project.slug}\``,
    `- Canonical source: \`${packet.project.canonicalSourcePath}\``,
  ];

  if (packet.project.baseline) {
    const baseline = packet.project.baseline;
    lines.push(
      `- Baseline revision ${baseline.revision}: \`${baseline.contentHash}\` (${baseline.fileCount} files, ${baseline.byteCount} bytes)`,
    );
  }

  if (packet.brief) {
    lines.push("", "## Brief", "", `**${packet.brief.title}**`, "");
    if (packet.brief.sourceInspirationId) {
      lines.push(
        `Source reference: \`${packet.brief.sourceInspirationId}\``,
        "",
      );
    }
    lines.push(packet.brief.markdown.trim());
  }

  if (packet.selectedDirection) {
    lines.push(
      "",
      "## Selected direction",
      "",
      `**${packet.selectedDirection.title}**`,
      "",
      packet.selectedDirection.rationale,
    );
  }

  lines.push("", "## Rounds", "");
  for (const round of packet.rounds) {
    lines.push(`- ${round.sequence}. ${round.stage} — ${round.status}`);
  }

  lines.push("", "## Artifacts", "");
  for (const artifact of packet.artifacts) {
    const controls =
      artifact.tweakControls === null
        ? "no manifest"
        : `${artifact.tweakControls} controls`;
    lines.push(
      `- ${artifact.directionTitle} · ${artifact.engine} · \`${artifact.artifactPath}\` (${controls})`,
    );
  }

  if (packet.decisions.length > 0) {
    lines.push("", "## Tweak decisions", "");
    for (const decision of packet.decisions) {
      lines.push(`### ${decision.label || "Untitled decisions"}`, "");
      lines.push(`Against \`${decision.artifactPath}\``, "");
      for (const [control, value] of Object.entries(decision.decisions)) {
        lines.push(`- \`${control}\`: ${String(value)}`);
      }
      lines.push("");
    }
  }

  if (packet.revisions.length > 0) {
    lines.push("", "## Applied revisions", "");
    for (const revision of packet.revisions) {
      lines.push(
        `- \`${revision.parentArtifactPath}\` → \`${revision.artifactPath}\` (${revision.status})`,
      );
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
