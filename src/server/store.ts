import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DesignBriefValidationError,
  parseDesignBrief,
  serializeDesignBrief,
} from "../shared/brief";

export type StoreErrorCode =
  "conflict" | "data_invalid" | "invalid" | "not_found";

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    readonly details?: unknown,
  ) {
    super(code);
    this.name = "StoreError";
  }
}

const nonEmpty = z.string().trim().min(1);
const identifier = nonEmpty.max(200);
const url = z.string().url();
const sourceStatus = z.enum(["captured", "partial", "blocked"]);
const stringList = z.array(nonEmpty).max(50);
const rejectEmptyUpdate = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
        ? null
        : value,
    schema,
  );

const inspirationInput = z
  .object({
    id: identifier.optional(),
    sourceUrl: url,
    resolvedUrl: url.nullable().optional(),
    title: nonEmpty,
    purpose: z.string().default(""),
    aestheticFamily: z.string().default(""),
    visualVocabulary: stringList.default([]),
    brief: z.string().default(""),
    captureType: nonEmpty,
    confidence: nonEmpty,
    sourceStatus,
    provenancePath: nonEmpty.optional(),
    limitation: z.string().nullable().optional(),
    tags: stringList.default([]),
    categoryIds: z.array(identifier).max(50).default([]),
  })
  .strict();

const inspirationUpdate = rejectEmptyUpdate(
  inspirationInput.omit({ id: true, provenancePath: true }).partial().strict(),
);

const inspirationFilters = z
  .object({
    q: z.string().trim().max(500).optional(),
    category: nonEmpty.optional(),
    tag: nonEmpty.optional(),
    source: z.string().trim().max(500).optional(),
    captureType: nonEmpty.optional(),
    sourceStatus: sourceStatus.optional(),
    confidence: nonEmpty.optional(),
  })
  .strict();

const categoryCreate = z
  .object({
    id: identifier.optional(),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: nonEmpty,
    description: z.string().default(""),
    inclusionRules: z.string().default(""),
    exclusionRules: z.string().default(""),
    isProvisional: z.boolean().default(false),
  })
  .strict();

const categoryUpdate = rejectEmptyUpdate(
  categoryCreate
    .omit({ id: true, isProvisional: true })
    .partial()
    .extend({ isRetired: z.boolean().optional() })
    .strict(),
);

const briefCreate = z
  .object({
    id: identifier.optional(),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    markdown: nonEmpty,
    sourceInspirationId: identifier.nullable().optional(),
  })
  .strict();

const briefUpdate = rejectEmptyUpdate(
  briefCreate.omit({ id: true }).partial().strict(),
);

const inspirationAssetInput = z
  .object({
    id: identifier.optional(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
    relativePath: z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.startsWith("\\") &&
          !value.split(/[\\/]/).includes(".."),
        "must be a contained relative path",
      ),
    mimeType: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
    role: nonEmpty,
    motionTimestampMs: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export interface InspirationAsset {
  id: string;
  relativePath: string;
  mimeType: string;
  role: string;
  contentHash: string | null;
  isAvailable: boolean;
  motionTimestampMs: number | null;
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  description: string;
  inclusionRules: string;
  exclusionRules: string;
  isProvisional: boolean;
  isRetired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Inspiration {
  id: string;
  sourceUrl: string;
  resolvedUrl: string | null;
  title: string;
  purpose: string;
  aestheticFamily: string;
  visualVocabulary: string[];
  brief: string;
  captureType: string;
  confidence: string;
  sourceStatus: z.infer<typeof sourceStatus>;
  provenancePath: string;
  limitation: string | null;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  categories: Category[];
  assets: InspirationAsset[];
}

export interface SavedBrief {
  id: string;
  slug: string;
  title: string;
  markdown: string;
  finalPrompt: string;
  sourceInspirationId: string | null;
  createdAt: string;
  updatedAt: string;
}

type InspirationRow = {
  id: string;
  source_url: string;
  resolved_url: string | null;
  title: string;
  purpose: string;
  aesthetic_family: string;
  visual_vocabulary: string;
  brief: string;
  capture_type: string;
  confidence: string;
  source_status: "captured" | "partial" | "blocked";
  provenance_path: string;
  limitation: string | null;
  created_at: string;
  updated_at: string;
};

type CategoryRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  inclusion_rules: string;
  exclusion_rules: string;
  is_provisional: number;
  is_retired: number;
  created_at: string;
  updated_at: string;
};

type BriefRow = {
  id: string;
  slug: string;
  title: string;
  markdown: string;
  final_prompt: string;
  source_inspiration_id: string | null;
  created_at: string;
  updated_at: string;
};

function validated<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new StoreError("invalid", result.error.issues);
  return result.data;
}

function translateSqlite(error: unknown): never {
  if (error instanceof StoreError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("UNIQUE constraint failed")) {
    throw new StoreError("conflict");
  }
  if (message.includes("FOREIGN KEY constraint failed")) {
    throw new StoreError("invalid");
  }
  throw error;
}

function categoryFromRow(row: CategoryRow): Category {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    inclusionRules: row.inclusion_rules,
    exclusionRules: row.exclusion_rules,
    isProvisional: row.is_provisional === 1,
    isRetired: row.is_retired === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function briefFromRow(row: BriefRow): SavedBrief {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    markdown: row.markdown,
    finalPrompt: row.final_prompt,
    sourceInspirationId: row.source_inspiration_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class LibraryStore {
  constructor(
    private readonly database: Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  listInspirations(input: unknown = {}): Inspiration[] {
    const filters = validated(inspirationFilters, input);
    const conditions: string[] = [];
    const parameters: Record<string, string> = {};
    if (filters.q) {
      conditions.push(
        `(i.title LIKE $q OR i.purpose LIKE $q OR i.aesthetic_family LIKE $q OR i.brief LIKE $q OR i.visual_vocabulary LIKE $q)`,
      );
      parameters.q = `%${filters.q}%`;
    }
    if (filters.category) {
      conditions.push(
        `EXISTS (SELECT 1 FROM inspiration_categories ic JOIN categories c ON c.id = ic.category_id WHERE ic.inspiration_id = i.id AND (c.id = $category OR c.slug = $category))`,
      );
      parameters.category = filters.category;
    }
    if (filters.tag) {
      conditions.push(
        `EXISTS (SELECT 1 FROM inspiration_tags it JOIN tags t ON t.id = it.tag_id WHERE it.inspiration_id = i.id AND t.name = $tag COLLATE NOCASE)`,
      );
      parameters.tag = filters.tag;
    }
    if (filters.source) {
      let source = filters.source;
      try {
        source = new URL(filters.source).hostname;
      } catch {
        // A hostname fragment is also a supported filter value.
      }
      conditions.push(
        `(i.source_url LIKE $source OR COALESCE(i.resolved_url, '') LIKE $source)`,
      );
      parameters.source = `%${source}%`;
    }
    for (const [field, column] of [
      ["captureType", "capture_type"],
      ["sourceStatus", "source_status"],
      ["confidence", "confidence"],
    ] as const) {
      const value = filters[field];
      if (value) {
        conditions.push(`i.${column} = $${field}`);
        parameters[field] = value;
      }
    }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.database
      .query<InspirationRow, Record<string, string>>(
        `SELECT i.* FROM inspirations i${where} ORDER BY i.created_at DESC, i.id`,
      )
      .all(parameters);
    return rows.map((row) => this.hydrateInspiration(row));
  }

  getInspiration(input: unknown): Inspiration {
    const id = validated(identifier, input);
    const row = this.database
      .query<InspirationRow, [string]>(
        "SELECT * FROM inspirations WHERE id = ?",
      )
      .get(id);
    if (!row) throw new StoreError("not_found");
    return this.hydrateInspiration(row);
  }

  createInspiration(input: unknown): Inspiration {
    const value = validated(inspirationInput, input);
    const id = value.id ?? randomUUID();
    const timestamp = this.now();
    try {
      this.database
        .transaction(() => {
          this.database
            .query(
              `INSERT INTO inspirations (
              id, source_url, resolved_url, title, purpose, aesthetic_family,
              visual_vocabulary, brief, capture_type, confidence, source_status,
              provenance_path, limitation, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              value.sourceUrl,
              value.resolvedUrl ?? null,
              value.title,
              value.purpose,
              value.aestheticFamily,
              JSON.stringify(value.visualVocabulary),
              value.brief,
              value.captureType,
              value.confidence,
              value.sourceStatus,
              value.provenancePath ?? `manual/${id}`,
              value.limitation ?? null,
              timestamp,
              timestamp,
            );
          this.replaceRelations(id, value.tags, value.categoryIds, timestamp);
        })
        .immediate();
    } catch (error) {
      translateSqlite(error);
    }
    return this.getInspiration(id);
  }

  updateInspiration(idInput: unknown, input: unknown): Inspiration {
    const current = this.getInspiration(idInput);
    const value = validated(inspirationUpdate, input);
    const timestamp = this.now();
    const merged = {
      sourceUrl: value.sourceUrl ?? current.sourceUrl,
      resolvedUrl:
        value.resolvedUrl === undefined
          ? current.resolvedUrl
          : value.resolvedUrl,
      title: value.title ?? current.title,
      purpose: value.purpose ?? current.purpose,
      aestheticFamily: value.aestheticFamily ?? current.aestheticFamily,
      visualVocabulary: value.visualVocabulary ?? current.visualVocabulary,
      brief: value.brief ?? current.brief,
      captureType: value.captureType ?? current.captureType,
      confidence: value.confidence ?? current.confidence,
      sourceStatus: value.sourceStatus ?? current.sourceStatus,
      limitation:
        value.limitation === undefined ? current.limitation : value.limitation,
    };
    try {
      this.database
        .transaction(() => {
          this.database
            .query(
              `UPDATE inspirations SET source_url = ?, resolved_url = ?, title = ?,
             purpose = ?, aesthetic_family = ?, visual_vocabulary = ?, brief = ?,
             capture_type = ?, confidence = ?, source_status = ?, limitation = ?,
             updated_at = ? WHERE id = ?`,
            )
            .run(
              merged.sourceUrl,
              merged.resolvedUrl,
              merged.title,
              merged.purpose,
              merged.aestheticFamily,
              JSON.stringify(merged.visualVocabulary),
              merged.brief,
              merged.captureType,
              merged.confidence,
              merged.sourceStatus,
              merged.limitation,
              timestamp,
              current.id,
            );
          if (value.tags !== undefined || value.categoryIds !== undefined) {
            this.replaceRelations(
              current.id,
              value.tags ?? current.tags,
              value.categoryIds ??
                current.categories.map((category) => category.id),
              timestamp,
            );
          }
        })
        .immediate();
    } catch (error) {
      translateSqlite(error);
    }
    return this.getInspiration(current.id);
  }

  addInspirationAsset(
    inspirationIdInput: unknown,
    input: unknown,
  ): Inspiration {
    const inspirationId = validated(identifier, inspirationIdInput);
    this.getInspiration(inspirationId);
    const value = validated(inspirationAssetInput, input);
    try {
      this.database
        .query(
          `INSERT INTO inspiration_assets (
            id, inspiration_id, content_hash, relative_path, mime_type, role,
            source, is_available, motion_timestamp_ms, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'user', 1, ?, ?)
          ON CONFLICT(inspiration_id, relative_path, role) DO UPDATE SET
            content_hash = excluded.content_hash,
            mime_type = excluded.mime_type,
            source = excluded.source,
            is_available = 1,
            motion_timestamp_ms = excluded.motion_timestamp_ms`,
        )
        .run(
          value.id ?? randomUUID(),
          inspirationId,
          value.contentHash.toLocaleLowerCase("en-US"),
          value.relativePath,
          value.mimeType.toLocaleLowerCase("en-US"),
          value.role,
          value.motionTimestampMs ?? null,
          this.now(),
        );
    } catch (error) {
      translateSqlite(error);
    }
    return this.getInspiration(inspirationId);
  }

  listCategories(input: unknown = {}): Category[] {
    const includeRetired = validated(
      z.object({ includeRetired: z.boolean().default(false) }).strict(),
      input,
    ).includeRetired;
    return this.database
      .query<CategoryRow, [number]>(
        `SELECT * FROM categories WHERE (? = 1 OR is_retired = 0)
         ORDER BY name COLLATE NOCASE`,
      )
      .all(includeRetired ? 1 : 0)
      .map(categoryFromRow);
  }

  createCategory(input: unknown): Category {
    const value = validated(categoryCreate, input);
    const id = value.id ?? randomUUID();
    const timestamp = this.now();
    try {
      this.database
        .query(
          `INSERT INTO categories (
            id, slug, name, description, inclusion_rules, exclusion_rules,
            is_provisional, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          value.slug,
          value.name,
          value.description,
          value.inclusionRules,
          value.exclusionRules,
          value.isProvisional ? 1 : 0,
          timestamp,
          timestamp,
        );
    } catch (error) {
      translateSqlite(error);
    }
    return this.getCategory(id);
  }

  updateCategory(idInput: unknown, input: unknown): Category {
    const current = this.getCategory(validated(identifier, idInput));
    const value = validated(categoryUpdate, input);
    try {
      this.database
        .query(
          `UPDATE categories SET slug = ?, name = ?, description = ?,
           inclusion_rules = ?, exclusion_rules = ?, is_retired = ?,
           updated_at = ? WHERE id = ?`,
        )
        .run(
          value.slug ?? current.slug,
          value.name ?? current.name,
          value.description ?? current.description,
          value.inclusionRules ?? current.inclusionRules,
          value.exclusionRules ?? current.exclusionRules,
          (value.isRetired ?? current.isRetired) ? 1 : 0,
          this.now(),
          current.id,
        );
    } catch (error) {
      translateSqlite(error);
    }
    return this.getCategory(current.id);
  }

  listBriefs(): SavedBrief[] {
    return this.database
      .query<BriefRow, []>("SELECT * FROM briefs ORDER BY created_at DESC, id")
      .all()
      .map(briefFromRow);
  }

  getBrief(input: unknown): SavedBrief {
    const id = validated(identifier, input);
    const rows = this.database
      .query<BriefRow, [string, string]>(
        "SELECT * FROM briefs WHERE id = ? OR slug = ? ORDER BY id",
      )
      .all(id, id);
    if (rows.length > 1) throw new StoreError("conflict");
    const row = rows[0];
    if (!row) throw new StoreError("not_found");
    return briefFromRow(row);
  }

  createBriefFromInspiration(input: unknown): SavedBrief {
    const inspiration = this.getInspiration(input);
    const existing = this.database
      .query<BriefRow, [string]>(
        "SELECT * FROM briefs WHERE source_inspiration_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(inspiration.id);
    if (existing) return briefFromRow(existing);

    const vocabulary = [...inspiration.visualVocabulary];
    for (const fallback of [
      inspiration.aestheticFamily,
      "reference-led composition",
      "content-preserving hierarchy",
      "responsive visual rhythm",
      "accessible interaction",
      "measured spacing",
    ]) {
      if (vocabulary.length >= 5) break;
      const value = fallback.trim();
      if (value && !vocabulary.includes(value)) vocabulary.push(value);
    }

    const markdown = serializeDesignBrief({
      title: `${inspiration.title} direction`,
      aestheticFamily: inspiration.aestheticFamily || "Reference-led direction",
      visualVocabulary: vocabulary.slice(0, 8),
      referencesAndBorrowedQualities: [
        `${inspiration.title}: borrow its ${inspiration.brief || inspiration.purpose || "documented visual qualities"}, not its content, identity, copy, or signature imagery.`,
      ],
      intent: `Test how the documented qualities from ${inspiration.title} can inform a local website direction without copying the reference.`,
      audience: "The intended audience of the selected local website project.",
      primaryAction:
        "Choose whether this direction should advance to comparison and refinement.",
      always: [
        "Preserve the local site's real content, accessibility, and responsive behavior.",
        "Use the reference as evidence for feel and design vocabulary only.",
      ],
      never: [
        "Copy the reference's branding, identity, copy, claims, or signature imagery.",
        "Hide evidence limitations or invent details that the captured source does not establish.",
      ],
      openRisks: [
        inspiration.limitation ||
          "The reference may not establish every implementation or motion detail.",
      ],
      finalCopyReadyGenerationPrompt:
        inspiration.brief ||
        `Create a ${inspiration.aestheticFamily || "reference-led"} website direction using ${vocabulary.slice(0, 5).join(", ")}. Preserve the target site's content and borrow feel rather than content from ${inspiration.title}.`,
    });

    return this.createBrief({
      slug: `inspiration-${inspiration.id}`,
      markdown,
      sourceInspirationId: inspiration.id,
    });
  }

  createBrief(input: unknown): SavedBrief {
    const value = validated(briefCreate, input);
    const parsed = this.parseBrief(value.markdown);
    const id = value.id ?? randomUUID();
    const timestamp = this.now();
    try {
      this.database
        .query(
          `INSERT INTO briefs (
            id, slug, title, markdown, final_prompt, source_inspiration_id,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          value.slug,
          parsed.title,
          value.markdown,
          parsed.finalCopyReadyGenerationPrompt,
          value.sourceInspirationId ?? null,
          timestamp,
          timestamp,
        );
    } catch (error) {
      translateSqlite(error);
    }
    return this.getBriefById(id);
  }

  updateBrief(idInput: unknown, input: unknown): SavedBrief {
    const current = this.getBrief(idInput);
    const value = validated(briefUpdate, input);
    const markdown = value.markdown ?? current.markdown;
    const parsed = this.parseBrief(markdown);
    try {
      this.database
        .query(
          `UPDATE briefs SET slug = ?, title = ?, markdown = ?, final_prompt = ?,
           source_inspiration_id = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          value.slug ?? current.slug,
          parsed.title,
          markdown,
          parsed.finalCopyReadyGenerationPrompt,
          value.sourceInspirationId === undefined
            ? current.sourceInspirationId
            : value.sourceInspirationId,
          this.now(),
          current.id,
        );
    } catch (error) {
      translateSqlite(error);
    }
    return this.getBriefById(current.id);
  }

  private getCategory(id: string): Category {
    const row = this.database
      .query<CategoryRow, [string]>("SELECT * FROM categories WHERE id = ?")
      .get(id);
    if (!row) throw new StoreError("not_found");
    return categoryFromRow(row);
  }

  private getBriefById(id: string): SavedBrief {
    const row = this.database
      .query<BriefRow, [string]>("SELECT * FROM briefs WHERE id = ?")
      .get(id);
    if (!row) throw new StoreError("not_found");
    return briefFromRow(row);
  }

  private parseBrief(markdown: string) {
    try {
      return parseDesignBrief(markdown);
    } catch (error) {
      if (error instanceof DesignBriefValidationError) {
        throw new StoreError("invalid", error.issues);
      }
      throw error;
    }
  }

  private replaceRelations(
    inspirationId: string,
    tags: readonly string[],
    categoryIds: readonly string[],
    timestamp: string,
  ): void {
    this.database
      .query("DELETE FROM inspiration_tags WHERE inspiration_id = ?")
      .run(inspirationId);
    const uniqueTags = new Map(
      tags.map((name) => [name.toLocaleLowerCase("en-US"), name] as const),
    );
    for (const name of uniqueTags.values()) {
      const id = randomUUID();
      this.database
        .query(
          `INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)
           ON CONFLICT(name) DO NOTHING`,
        )
        .run(id, name, timestamp);
      const tag = this.database
        .query<{ id: string }, [string]>("SELECT id FROM tags WHERE name = ?")
        .get(name);
      if (!tag) throw new StoreError("conflict");
      this.database
        .query(
          `INSERT INTO inspiration_tags (inspiration_id, tag_id, source)
           VALUES (?, ?, 'user')`,
        )
        .run(inspirationId, tag.id);
    }
    this.database
      .query("DELETE FROM inspiration_categories WHERE inspiration_id = ?")
      .run(inspirationId);
    for (const categoryId of new Set(categoryIds)) {
      this.database
        .query(
          `INSERT INTO inspiration_categories (inspiration_id, category_id)
           VALUES (?, ?)`,
        )
        .run(inspirationId, categoryId);
    }
  }

  private hydrateInspiration(row: InspirationRow): Inspiration {
    let vocabulary: unknown;
    try {
      vocabulary = JSON.parse(row.visual_vocabulary);
    } catch {
      throw new StoreError("data_invalid", "invalid_visual_vocabulary");
    }
    const parsedVocabulary = stringList.safeParse(vocabulary);
    if (!parsedVocabulary.success) {
      throw new StoreError("data_invalid", "invalid_visual_vocabulary");
    }
    const tags = this.database
      .query<{ name: string }, [string]>(
        `SELECT t.name FROM tags t
         JOIN inspiration_tags it ON it.tag_id = t.id
         WHERE it.inspiration_id = ? ORDER BY t.name COLLATE NOCASE`,
      )
      .all(row.id)
      .map(({ name }) => name);
    const categories = this.database
      .query<CategoryRow, [string]>(
        `SELECT c.* FROM categories c
         JOIN inspiration_categories ic ON ic.category_id = c.id
         WHERE ic.inspiration_id = ? ORDER BY c.name COLLATE NOCASE`,
      )
      .all(row.id)
      .map(categoryFromRow);
    const assets = this.database
      .query<
        {
          id: string;
          relative_path: string;
          mime_type: string;
          role: string;
          content_hash: string | null;
          is_available: number;
          motion_timestamp_ms: number | null;
        },
        [string]
      >(
        `SELECT id, relative_path, mime_type, role, content_hash, is_available,
                motion_timestamp_ms
         FROM inspiration_assets WHERE inspiration_id = ?
         ORDER BY role, relative_path`,
      )
      .all(row.id)
      .map((asset) => ({
        id: asset.id,
        relativePath: asset.relative_path,
        mimeType: asset.mime_type,
        role: asset.role,
        contentHash: asset.content_hash,
        isAvailable: asset.is_available === 1,
        motionTimestampMs: asset.motion_timestamp_ms,
      }));
    return {
      id: row.id,
      sourceUrl: row.source_url,
      resolvedUrl: row.resolved_url,
      title: row.title,
      purpose: row.purpose,
      aestheticFamily: row.aesthetic_family,
      visualVocabulary: parsedVocabulary.data,
      brief: row.brief,
      captureType: row.capture_type,
      confidence: row.confidence,
      sourceStatus: row.source_status,
      provenancePath: row.provenance_path,
      limitation: row.limitation,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tags,
      categories,
      assets,
    };
  }
}
