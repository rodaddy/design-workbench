import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const jsonObjectSchema = z.record(z.string(), z.json());
const registerVariantSchema = z
  .object({
    comparison: z.string().trim().min(1),
    direction: z.string().trim().min(1),
    engine: z.enum(["impeccable", "taste"]),
    path: z.string().trim().min(1),
    generatedRoot: z.string().trim().min(1),
    viewport: jsonObjectSchema.default({}),
    metadata: jsonObjectSchema.default({}),
  })
  .strict();

type ComparisonRow = { id: string };
type DirectionRow = { id: string; slug: string };
type VariantRow = {
  id: string;
  artifact_path: string;
  created_at: string;
  updated_at: string;
};

export type RegisteredVariant = {
  id: string;
  comparisonId: string;
  directionId: string;
  engine: "impeccable" | "taste";
  artifactPath: string;
  createdAt: string;
  updatedAt: string;
};

export class VariantRegistrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VariantRegistrationError";
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

function canonicalDirectory(path: string, code: string, label: string): string {
  try {
    const canonical = realpathSync(resolve(path));
    if (!statSync(canonical).isDirectory()) {
      throw new Error(`${label} is not a directory`);
    }
    return canonical;
  } catch (error) {
    throw new VariantRegistrationError(code, `${label} is invalid`, {
      cause: error,
    });
  }
}

function boundedJson(
  value: Record<string, z.infer<typeof z.json>>,
  label: string,
): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > 65_536) {
    throw new VariantRegistrationError(
      "VARIANT_METADATA_TOO_LARGE",
      `${label} exceeds 65536 bytes`,
    );
  }
  return json;
}

export function registerVariant(
  database: Database,
  input: unknown,
): RegisteredVariant {
  const parsed = registerVariantSchema.safeParse(input);
  if (!parsed.success) {
    throw new VariantRegistrationError(
      "INVALID_VARIANT_INPUT",
      "Variant registration input is invalid",
      { cause: parsed.error },
    );
  }

  const comparisons = database
    .query<ComparisonRow, [string, string]>(
      `SELECT id FROM comparisons
       WHERE id = ? OR slug = ?
       ORDER BY id
       LIMIT 2`,
    )
    .all(parsed.data.comparison, parsed.data.comparison);
  if (comparisons.length === 0) {
    throw new VariantRegistrationError(
      "COMPARISON_NOT_FOUND",
      `No comparison exists for '${parsed.data.comparison}'`,
    );
  }
  if (comparisons.length > 1) {
    throw new VariantRegistrationError(
      "COMPARISON_CONFLICT",
      `Comparison identifier '${parsed.data.comparison}' is ambiguous`,
    );
  }
  const comparison = comparisons[0];

  const directions = database
    .query<DirectionRow, [string, string, string]>(
      `SELECT id, slug FROM aesthetic_directions
       WHERE comparison_id = ? AND (id = ? OR slug = ?)
       ORDER BY id
       LIMIT 2`,
    )
    .all(comparison.id, parsed.data.direction, parsed.data.direction);
  if (directions.length === 0) {
    throw new VariantRegistrationError(
      "DIRECTION_NOT_FOUND",
      `No matching direction belongs to comparison '${parsed.data.comparison}'`,
    );
  }
  if (directions.length > 1) {
    throw new VariantRegistrationError(
      "DIRECTION_CONFLICT",
      `Direction identifier '${parsed.data.direction}' is ambiguous within comparison '${parsed.data.comparison}'`,
    );
  }
  const direction = directions[0];

  const canonicalRoot = canonicalDirectory(
    parsed.data.generatedRoot,
    "INVALID_GENERATED_ROOT",
    "Generated variants root",
  );
  const canonicalArtifact = canonicalDirectory(
    parsed.data.path,
    "INVALID_VARIANT_PATH",
    "Variant artifact directory",
  );
  if (!contained(canonicalRoot, canonicalArtifact)) {
    throw new VariantRegistrationError(
      "INVALID_VARIANT_PATH",
      "Variant artifact directory escapes the generated variants root",
    );
  }

  const expectedArtifact = resolve(
    canonicalRoot,
    comparison.id,
    direction.slug,
    parsed.data.engine,
  );
  let canonicalExpected: string;
  try {
    canonicalExpected = realpathSync(expectedArtifact);
  } catch (error) {
    throw new VariantRegistrationError(
      "INVALID_VARIANT_PATH",
      "Variant artifact directory does not match its comparison packet",
      { cause: error },
    );
  }
  if (canonicalArtifact !== canonicalExpected) {
    throw new VariantRegistrationError(
      "INVALID_VARIANT_PATH",
      "Variant artifact directory does not match its comparison, direction, and engine",
    );
  }

  let indexPath: string;
  try {
    indexPath = realpathSync(resolve(canonicalArtifact, "index.html"));
    if (
      !contained(canonicalArtifact, indexPath) ||
      !statSync(indexPath).isFile()
    ) {
      throw new Error("index.html is not a contained regular file");
    }
  } catch (error) {
    throw new VariantRegistrationError(
      "VARIANT_INDEX_MISSING",
      "Variant artifact must contain a regular index.html",
      { cause: error },
    );
  }

  const artifactPath = relative(canonicalRoot, canonicalArtifact);
  const viewport = boundedJson(parsed.data.viewport, "Viewport");
  const metadata = boundedJson(parsed.data.metadata, "Metadata");
  const now = new Date().toISOString();
  const id = randomUUID();
  database
    .query(
      `INSERT INTO variants (
        id, direction_id, engine, artifact_path, viewport, metadata,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(direction_id, engine) DO UPDATE SET
        artifact_path = excluded.artifact_path,
        viewport = excluded.viewport,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at`,
    )
    .run(
      id,
      direction.id,
      parsed.data.engine,
      artifactPath,
      viewport,
      metadata,
      now,
      now,
    );

  const row = database
    .query<VariantRow, [string, string]>(
      `SELECT id, artifact_path, created_at, updated_at
       FROM variants WHERE direction_id = ? AND engine = ?`,
    )
    .get(direction.id, parsed.data.engine);
  if (!row) {
    throw new VariantRegistrationError(
      "VARIANT_REGISTER_FAILED",
      "Variant registration did not persist",
    );
  }

  return {
    id: row.id,
    comparisonId: comparison.id,
    directionId: direction.id,
    engine: parsed.data.engine,
    artifactPath: row.artifact_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
