import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import {
  parseWorkbenchTweakValue,
  workbenchTweakManifestSchema,
  type WorkbenchTweakManifest,
  type WorkbenchTweakValue,
} from "../shared/tweaks";

/**
 * Persisted tweak decisions.
 *
 * Decisions are validated against the variant's own manifest before they are
 * stored, so a saved snapshot can only ever contain values the tweak protocol
 * would actually accept. Storing an unvalidated blob would let the dock save
 * something that silently fails to apply on restore.
 */

const identifier = z.string().trim().min(1).max(200);

const saveSchema = z
  .object({
    variantId: identifier,
    label: z.string().trim().max(200).default(""),
    decisions: z.record(z.string(), z.unknown()),
    idempotencyKey: identifier,
  })
  .strict();

export type SaveTweakDecisionsInput = z.input<typeof saveSchema>;

export interface TweakDecisionSet {
  id: string;
  projectId: string;
  variantId: string;
  artifactPath: string;
  label: string;
  decisions: Record<string, WorkbenchTweakValue>;
  createdAt: string;
  updatedAt: string;
}

type DecisionRow = {
  id: string;
  project_id: string;
  variant_id: string;
  artifact_path: string;
  label: string;
  decisions: string;
  created_at: string;
  updated_at: string;
};

export class TweakDecisionError extends Error {
  constructor(
    readonly code:
      | "TWEAK_CONFLICT"
      | "TWEAK_DATA_INVALID"
      | "TWEAK_INVALID_INPUT"
      | "TWEAK_NOT_FOUND",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TweakDecisionError";
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Read and validate the manifest a variant is actually served with. */
export function loadVariantManifest(
  generatedVariantsRoot: string,
  artifactPath: string,
): WorkbenchTweakManifest {
  const manifestPath = resolve(
    generatedVariantsRoot,
    artifactPath,
    "workbench.json",
  );
  if (!existsSync(manifestPath)) {
    throw new TweakDecisionError(
      "TWEAK_NOT_FOUND",
      "This variant has no tweak manifest",
    );
  }
  try {
    return workbenchTweakManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
  } catch (error) {
    throw new TweakDecisionError(
      "TWEAK_DATA_INVALID",
      "Variant tweak manifest is invalid",
      { cause: error },
    );
  }
}

/**
 * Validate a decision map against a manifest. Unknown control ids and values
 * the control would reject are errors rather than being dropped, because a
 * silently discarded decision looks saved but never applies.
 */
export function validateDecisions(
  manifest: WorkbenchTweakManifest,
  decisions: Record<string, unknown>,
): Record<string, WorkbenchTweakValue> {
  const byId = new Map(manifest.controls.map((c) => [c.id, c]));
  const validated: Record<string, WorkbenchTweakValue> = {};
  for (const [controlId, value] of Object.entries(decisions)) {
    const control = byId.get(controlId);
    if (!control) {
      throw new TweakDecisionError(
        "TWEAK_INVALID_INPUT",
        `Unknown tweak control '${controlId}' for this variant`,
      );
    }
    try {
      validated[controlId] = parseWorkbenchTweakValue(control, value);
    } catch (error) {
      throw new TweakDecisionError(
        "TWEAK_INVALID_INPUT",
        `Value for '${controlId}' is not valid for a ${control.type} control`,
        { cause: error },
      );
    }
  }
  return validated;
}

export class TweakDecisionStore {
  constructor(
    private readonly database: Database,
    private readonly generatedVariantsRoot: string,
  ) {}

  private toDecisionSet(row: DecisionRow): TweakDecisionSet {
    let decisions: Record<string, WorkbenchTweakValue>;
    try {
      decisions = JSON.parse(row.decisions) as Record<
        string,
        WorkbenchTweakValue
      >;
    } catch (error) {
      throw new TweakDecisionError(
        "TWEAK_DATA_INVALID",
        "Stored tweak decisions are invalid",
        { cause: error },
      );
    }
    return {
      id: row.id,
      projectId: row.project_id,
      variantId: row.variant_id,
      artifactPath: row.artifact_path,
      label: row.label,
      decisions,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  get(decisionId: string): TweakDecisionSet {
    const row = this.database
      .query<DecisionRow, [string]>(
        "SELECT * FROM tweak_decisions WHERE id = ?",
      )
      .get(identifier.parse(decisionId));
    if (!row) {
      throw new TweakDecisionError(
        "TWEAK_NOT_FOUND",
        "Tweak decision set does not exist",
      );
    }
    return this.toDecisionSet(row);
  }

  listForVariant(variantId: string): TweakDecisionSet[] {
    return this.database
      .query<DecisionRow, [string]>(
        `SELECT * FROM tweak_decisions WHERE variant_id = ?
         ORDER BY created_at DESC, id`,
      )
      .all(identifier.parse(variantId))
      .map((row) => this.toDecisionSet(row));
  }

  /** Save a decision set, validated against the variant's live manifest. */
  save(input: SaveTweakDecisionsInput): TweakDecisionSet {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) {
      throw new TweakDecisionError(
        "TWEAK_INVALID_INPUT",
        "Tweak decision input is invalid",
        { cause: parsed.error },
      );
    }
    const value = parsed.data;

    const variant = this.database
      .query<
        { id: string; artifact_path: string; project_id: string | null },
        [string]
      >(
        `SELECT v.id, v.artifact_path,
                (SELECT r.project_id FROM exploration_rounds AS r
                 WHERE r.comparison_id = d.comparison_id
                 ORDER BY r.sequence LIMIT 1) AS project_id
         FROM variants AS v
         JOIN aesthetic_directions AS d ON d.id = v.direction_id
         WHERE v.id = ?`,
      )
      .get(value.variantId);
    if (!variant) {
      throw new TweakDecisionError("TWEAK_NOT_FOUND", "Variant does not exist");
    }
    if (!variant.project_id) {
      throw new TweakDecisionError(
        "TWEAK_DATA_INVALID",
        "Variant is not linked to a Studio project",
      );
    }

    const manifest = loadVariantManifest(
      this.generatedVariantsRoot,
      variant.artifact_path,
    );
    const decisions = validateDecisions(manifest, value.decisions);

    const requestFingerprint = fingerprint({
      variantId: value.variantId,
      label: value.label,
      decisions,
    });
    const existing = this.database
      .query<DecisionRow & { request_fingerprint: string }, [string, string]>(
        `SELECT * FROM tweak_decisions
         WHERE project_id = ? AND idempotency_key = ?`,
      )
      .get(variant.project_id, value.idempotencyKey);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw new TweakDecisionError(
          "TWEAK_CONFLICT",
          "Tweak idempotency key was used for different decisions",
        );
      }
      return this.toDecisionSet(existing);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    this.database
      .query(
        `INSERT INTO tweak_decisions (
          id, project_id, variant_id, artifact_path, label, decisions,
          idempotency_key, request_fingerprint, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        variant.project_id,
        value.variantId,
        variant.artifact_path,
        value.label,
        JSON.stringify(decisions),
        value.idempotencyKey,
        requestFingerprint,
        now,
        now,
      );
    return this.get(id);
  }

  /**
   * Restore a decision set, re-validating against the manifest as it is now.
   * A manifest that changed since the snapshot was taken can invalidate stored
   * decisions, and reporting that is more useful than applying a stale value.
   */
  restore(decisionId: string): {
    decisionSet: TweakDecisionSet;
    manifest: WorkbenchTweakManifest;
    decisions: Record<string, WorkbenchTweakValue>;
  } {
    const decisionSet = this.get(decisionId);
    const manifest = loadVariantManifest(
      this.generatedVariantsRoot,
      decisionSet.artifactPath,
    );
    return {
      decisionSet,
      manifest,
      decisions: validateDecisions(manifest, decisionSet.decisions),
    };
  }
}
