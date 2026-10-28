import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { type DesignBrief, parseDesignBrief } from "../shared/brief";

const createComparisonSchema = z
  .object({
    brief: z.string().trim().min(1),
    directions: z.number().int().min(1).max(5),
    generatedRoot: z.string().trim().min(1),
  })
  .strict();

const comparisonIdentifierSchema = z.string().trim().min(1).max(200);
const updateComparisonSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    status: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .refine((value) => value.title !== undefined || value.status !== undefined, {
    message: "At least one update field is required",
  });
const jsonObjectSchema = z.record(z.string(), z.unknown());

type BriefRow = {
  id: string;
  markdown: string;
};

type ResolvedBrief = BriefRow & {
  parsed: DesignBrief;
  pendingImport?: {
    slug: string;
    title: string;
    finalPrompt: string;
  };
};

type ComparisonRow = {
  id: string;
  slug: string;
  title: string;
  source_brief_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

type DirectionRow = {
  id: string;
  comparison_id: string;
  slug: string;
  title: string;
  position: number;
  metadata: string;
  created_at: string;
};

type VariantRow = {
  id: string;
  direction_id: string;
  engine: "impeccable" | "taste";
  artifact_path: string;
  viewport: string;
  metadata: string;
  created_at: string;
  updated_at: string;
};

export type ComparisonDirection = {
  id: string;
  position: number;
  slug: string;
  title: string;
};

export type HydratedVariant = {
  id: string;
  engine: "impeccable" | "taste";
  artifactPath: string;
  viewport: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type HydratedDirection = ComparisonDirection & {
  metadata: Record<string, unknown>;
  createdAt: string;
  variants: HydratedVariant[];
};

export type HydratedComparison = {
  id: string;
  slug: string;
  title: string;
  sourceBriefId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  directions: HydratedDirection[];
};

export type ComparisonPacket = {
  schemaVersion: 1;
  comparison: {
    id: string;
    slug: string;
    title: string;
  };
  sourceBrief: {
    id: string;
    markdown: string;
    parsed: DesignBrief;
  };
  directions: Array<
    ComparisonDirection & {
      engines: {
        impeccable: string;
        taste: string;
      };
    }
  >;
};

export type CreatedComparison = {
  comparisonId: string;
  directory: string;
  packetPath: string;
  directions: ComparisonDirection[];
};

export class ComparisonError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ComparisonError";
  }
}

function invalidInput(cause: z.ZodError): ComparisonError {
  return new ComparisonError(
    "INVALID_COMPARISON_INPUT",
    "Comparison input is invalid",
    { cause },
  );
}

function parseJsonObject(
  value: string,
  field: string,
): Record<string, unknown> {
  try {
    const result = jsonObjectSchema.safeParse(JSON.parse(value));
    if (result.success) return result.data;
    throw result.error;
  } catch (error) {
    throw new ComparisonError(
      "COMPARISON_DATA_INVALID",
      `Stored ${field} is invalid`,
      { cause: error },
    );
  }
}

function comparisonRowsByIdentifier(
  database: Database,
  identifier: unknown,
): ComparisonRow[] {
  const parsed = comparisonIdentifierSchema.safeParse(identifier);
  if (!parsed.success) throw invalidInput(parsed.error);
  const rows = database
    .query<ComparisonRow, [string, string]>(
      `SELECT id, slug, title, source_brief_id, status, created_at, updated_at
       FROM comparisons
       WHERE id = ? OR slug = ?
       ORDER BY id
       LIMIT 2`,
    )
    .all(parsed.data, parsed.data);
  if (rows.length === 0) {
    throw new ComparisonError(
      "COMPARISON_NOT_FOUND",
      `No comparison exists for '${parsed.data}'`,
    );
  }
  if (rows.length > 1) {
    throw new ComparisonError(
      "COMPARISON_CONFLICT",
      `Comparison identifier '${parsed.data}' is ambiguous`,
    );
  }
  return rows;
}

function hydrateComparison(
  database: Database,
  comparison: ComparisonRow,
): HydratedComparison {
  const directions = database
    .query<DirectionRow, [string]>(
      `SELECT id, comparison_id, slug, title, position, metadata, created_at
       FROM aesthetic_directions
       WHERE comparison_id = ?
       ORDER BY position, id`,
    )
    .all(comparison.id);
  const variantsByDirection = new Map<string, HydratedVariant[]>();
  if (directions.length > 0) {
    const variants = database
      .query<VariantRow, [string]>(
        `SELECT v.id, v.direction_id, v.engine, v.artifact_path, v.viewport,
                v.metadata, v.created_at, v.updated_at
         FROM variants AS v
         JOIN aesthetic_directions AS d ON d.id = v.direction_id
         WHERE d.comparison_id = ?
         ORDER BY d.position, v.engine, v.id`,
      )
      .all(comparison.id);
    for (const variant of variants) {
      const hydrated: HydratedVariant = {
        id: variant.id,
        engine: variant.engine,
        artifactPath: variant.artifact_path,
        viewport: parseJsonObject(variant.viewport, "variant viewport"),
        metadata: parseJsonObject(variant.metadata, "variant metadata"),
        createdAt: variant.created_at,
        updatedAt: variant.updated_at,
      };
      const existing = variantsByDirection.get(variant.direction_id);
      if (existing) existing.push(hydrated);
      else variantsByDirection.set(variant.direction_id, [hydrated]);
    }
  }

  return {
    id: comparison.id,
    slug: comparison.slug,
    title: comparison.title,
    sourceBriefId: comparison.source_brief_id,
    status: comparison.status,
    createdAt: comparison.created_at,
    updatedAt: comparison.updated_at,
    directions: directions.map((direction) => ({
      id: direction.id,
      slug: direction.slug,
      title: direction.title,
      position: direction.position,
      metadata: parseJsonObject(direction.metadata, "direction metadata"),
      createdAt: direction.created_at,
      variants: variantsByDirection.get(direction.id) ?? [],
    })),
  };
}

export function listComparisons(database: Database): HydratedComparison[] {
  return database
    .query<ComparisonRow, []>(
      `SELECT id, slug, title, source_brief_id, status, created_at, updated_at
       FROM comparisons
       ORDER BY created_at DESC, id`,
    )
    .all()
    .map((comparison) => hydrateComparison(database, comparison));
}

export function getComparison(
  database: Database,
  identifier: unknown,
): HydratedComparison {
  const [comparison] = comparisonRowsByIdentifier(database, identifier);
  if (!comparison) {
    throw new ComparisonError(
      "COMPARISON_NOT_FOUND",
      "Comparison does not exist",
    );
  }
  return hydrateComparison(database, comparison);
}

export function updateComparison(
  database: Database,
  identifier: unknown,
  input: unknown,
  options: { beforeWrite?: () => void } = {},
): HydratedComparison {
  const parsed = updateComparisonSchema.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error);
  const [comparison] = comparisonRowsByIdentifier(database, identifier);
  if (!comparison) {
    throw new ComparisonError(
      "COMPARISON_NOT_FOUND",
      "Comparison does not exist",
    );
  }
  const title = parsed.data.title ?? comparison.title;
  const status = parsed.data.status ?? comparison.status;
  const updatedAt = new Date().toISOString();
  options.beforeWrite?.();
  const result = database
    .query(
      `UPDATE comparisons
       SET title = ?, status = ?, updated_at = ?
       WHERE id = ? AND updated_at = ?`,
    )
    .run(title, status, updatedAt, comparison.id, comparison.updated_at);
  if (result.changes !== 1) {
    throw new ComparisonError(
      "COMPARISON_CONFLICT",
      "Comparison changed before the update completed",
    );
  }
  return getComparison(database, comparison.id);
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "comparison";
}

function containedPath(root: string, ...parts: string[]): string {
  const canonicalRoot = resolve(root);
  const candidate = resolve(canonicalRoot, ...parts);
  const pathFromRoot = relative(canonicalRoot, candidate);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    pathFromRoot.includes(`${sep}..${sep}`)
  ) {
    throw new ComparisonError(
      "INVALID_GENERATED_PATH",
      "Generated path escapes the configured root",
    );
  }
  return candidate;
}

function loadBriefFromDatabase(database: Database, id: string): ResolvedBrief {
  const row = database
    .query<BriefRow, [string, string]>(
      "SELECT id, markdown FROM briefs WHERE id = ? OR slug = ? LIMIT 1",
    )
    .get(id, id);
  if (!row) {
    throw new ComparisonError("BRIEF_NOT_FOUND", `No brief exists for '${id}'`);
  }
  return { ...row, parsed: parseDesignBrief(row.markdown) };
}

function readBriefImport(path: string): ResolvedBrief {
  let markdown: string;
  try {
    markdown = readFileSync(path, "utf8");
  } catch (error) {
    throw new ComparisonError(
      "BRIEF_READ_FAILED",
      `Could not read brief '${path}'`,
      { cause: error },
    );
  }

  const parsed = parseDesignBrief(markdown);
  const digest = createHash("sha256").update(markdown).digest("hex");
  const id = `brief-${digest.slice(0, 16)}`;
  const slug = `${slugify(parsed.title)}-${digest.slice(0, 8)}`;
  return {
    id,
    markdown,
    parsed,
    pendingImport: {
      slug,
      title: parsed.title,
      finalPrompt: parsed.finalCopyReadyGenerationPrompt,
    },
  };
}

function resolveBrief(database: Database, input: string): ResolvedBrief {
  const path = resolve(input);
  return existsSync(path)
    ? readBriefImport(path)
    : loadBriefFromDatabase(database, input);
}

function archiveDirectory(path: string, generatedRoot: string): void {
  if (!existsSync(path)) return;
  const archiveRoot = containedPath(generatedRoot, "_archive");
  mkdirSync(archiveRoot, { recursive: true });
  const destination = containedPath(
    archiveRoot,
    `${basename(path)}-${Date.now()}-${randomUUID()}`,
  );
  renameSync(path, destination);
}

export function createComparison(
  database: Database,
  input: unknown,
): CreatedComparison {
  const parsedInput = createComparisonSchema.safeParse(input);
  if (!parsedInput.success) {
    throw invalidInput(parsedInput.error);
  }

  const sourceBrief = resolveBrief(database, parsedInput.data.brief);
  const brief = sourceBrief.parsed;
  const comparisonId = randomUUID();
  const comparisonSlug = `${slugify(brief.title)}-${comparisonId.slice(0, 8)}`;
  const directions = Array.from(
    { length: parsedInput.data.directions },
    (_, index): ComparisonDirection => ({
      id: randomUUID(),
      position: index,
      slug: `direction-${index + 1}`,
      title: `Direction ${index + 1}`,
    }),
  );
  const generatedRoot = resolve(parsedInput.data.generatedRoot);
  const finalDirectory = containedPath(generatedRoot, comparisonId);
  const stagingDirectory = containedPath(
    generatedRoot,
    `_staging-${comparisonId}`,
  );
  const packetPath = containedPath(finalDirectory, "comparison.json");
  const packet: ComparisonPacket = {
    schemaVersion: 1,
    comparison: {
      id: comparisonId,
      slug: comparisonSlug,
      title: brief.title,
    },
    sourceBrief: {
      id: sourceBrief.id,
      markdown: sourceBrief.markdown,
      parsed: brief,
    },
    directions: directions.map((direction) => ({
      ...direction,
      engines: {
        impeccable: `${direction.slug}/impeccable`,
        taste: `${direction.slug}/taste`,
      },
    })),
  };

  if (existsSync(finalDirectory) || existsSync(stagingDirectory)) {
    throw new ComparisonError(
      "COMPARISON_DIRECTORY_EXISTS",
      "Comparison output directory already exists",
    );
  }

  try {
    mkdirSync(stagingDirectory, { recursive: true });
    for (const direction of directions) {
      mkdirSync(containedPath(stagingDirectory, direction.slug, "impeccable"), {
        recursive: true,
      });
      mkdirSync(containedPath(stagingDirectory, direction.slug, "taste"), {
        recursive: true,
      });
    }
    writeFileSync(
      containedPath(stagingDirectory, "comparison.json"),
      `${JSON.stringify(packet, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );

    const persist = database.transaction(() => {
      const now = new Date().toISOString();
      if (sourceBrief.pendingImport) {
        database
          .query(
            `INSERT INTO briefs (
              id, slug, title, markdown, final_prompt, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              markdown = excluded.markdown,
              final_prompt = excluded.final_prompt,
              updated_at = excluded.updated_at`,
          )
          .run(
            sourceBrief.id,
            sourceBrief.pendingImport.slug,
            sourceBrief.pendingImport.title,
            sourceBrief.markdown,
            sourceBrief.pendingImport.finalPrompt,
            now,
            now,
          );
      }
      database
        .query(
          `INSERT INTO comparisons (
            id, slug, title, source_brief_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          comparisonId,
          comparisonSlug,
          brief.title,
          sourceBrief.id,
          "draft",
          now,
          now,
        );
      const insertDirection = database.query(
        `INSERT INTO aesthetic_directions (
          id, comparison_id, slug, title, position, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const direction of directions) {
        insertDirection.run(
          direction.id,
          comparisonId,
          direction.slug,
          direction.title,
          direction.position,
          "{}",
          now,
        );
      }
      mkdirSync(dirname(finalDirectory), { recursive: true });
      renameSync(stagingDirectory, finalDirectory);
    });
    persist.immediate();
  } catch (error) {
    try {
      archiveDirectory(
        existsSync(finalDirectory) ? finalDirectory : stagingDirectory,
        generatedRoot,
      );
    } catch (archiveError) {
      throw new ComparisonError(
        "COMPARISON_ROLLBACK_FAILED",
        "Comparison failed and its output could not be archived",
        { cause: archiveError },
      );
    }
    if (error instanceof ComparisonError) throw error;
    throw new ComparisonError(
      "COMPARISON_CREATE_FAILED",
      "Comparison creation failed",
      { cause: error },
    );
  }

  return {
    comparisonId,
    directory: finalDirectory,
    packetPath,
    directions,
  };
}
