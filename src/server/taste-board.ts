import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const TASTE_BOARD_IMPORT_ERROR = "TASTE_BOARD_IMPORT_FAILED";

export class TasteBoardImportError extends Error {
  readonly code = TASTE_BOARD_IMPORT_ERROR;

  constructor(
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`${TASTE_BOARD_IMPORT_ERROR}: ${detail}`, options);
    this.name = "TasteBoardImportError";
  }
}

const manifestEntrySchema = z.object({
  original_url: z.string().url(),
  resolved_url: z.string().url(),
  entry_path: z.string().min(1),
  evidence_paths: z.array(z.string().min(1)),
  capture_type: z.string().min(1),
  status: z.enum(["captured", "partial", "blocked"]),
  limitation: z.string(),
});

const inspirationManifestSchema = z.array(manifestEntrySchema).min(1);
const categoryDocumentSchema = z.object({
  document: z.string().min(1),
  evidence: z.array(z.string().min(1)),
});
const categoryManifestSchema = z.object({
  status: z.literal("provisional"),
  source: z.string().min(1),
  documents: z.array(categoryDocumentSchema).min(1),
});

interface MarkdownDocument {
  readonly title: string;
  readonly metadata: ReadonlyMap<string, string>;
  readonly sections: ReadonlyMap<string, string>;
}

const markdownDocumentSchema: z.ZodType<MarkdownDocument> = z.object({
  title: z.string().min(1),
  metadata: z.map(z.string(), z.string()),
  sections: z.map(z.string(), z.string()),
});

interface InspirationSeed {
  readonly sourceUrl: string;
  readonly resolvedUrl: string;
  readonly title: string;
  readonly purpose: string;
  readonly aestheticFamily: string;
  readonly vocabulary: readonly string[];
  readonly brief: string;
  readonly captureType: string;
  readonly confidence: string;
  readonly sourceStatus: "captured" | "partial" | "blocked";
  readonly limitation: string;
  readonly provenancePath: string;
  readonly evidencePaths: readonly string[];
  readonly tags: readonly string[];
}

export interface TasteBoardImportResult {
  readonly inspirations: number;
  readonly categories: number;
}

const INSPIRATION_MANIFESTS = [
  "taste-board/inbox/batch-001/pinterest/manifest.json",
  "taste-board/inbox/batch-001/dribbble/manifest.json",
  "taste-board/inbox/batch-001/galleries/manifest.json",
  "taste-board/inbox/batch-001/direct-sites/manifest.json",
] as const;
const CATEGORY_MANIFEST = "taste-board/categories/video-seeds/manifest.json";
const STILLNESS_EXAMPLE =
  "taste-board/categories/video-seeds/stillness-example.md";

function stableId(namespace: string, value: string): string {
  return `${namespace}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function containedPath(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(absoluteRoot, candidate);
  rejectPathEscape(absoluteRoot, absoluteCandidate, candidate);

  if (existsSync(absoluteCandidate)) {
    const canonicalRoot = realpathSync(absoluteRoot);
    const canonicalCandidate = realpathSync(absoluteCandidate);
    rejectPathEscape(canonicalRoot, canonicalCandidate, candidate);
  }
  return absoluteCandidate;
}

function rejectPathEscape(
  root: string,
  candidate: string,
  displayPath: string,
): void {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    pathFromRoot.startsWith(sep)
  ) {
    throw new TasteBoardImportError(`path_outside_repo:${displayPath}`);
  }
}

function readValidatedJson<T>(
  repoRoot: string,
  path: string,
  schema: z.ZodType<T>,
): T {
  try {
    const value: unknown = JSON.parse(
      readFileSync(containedPath(repoRoot, path), "utf8"),
    );
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new TasteBoardImportError(`invalid_manifest:${path}`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof TasteBoardImportError) {
      throw error;
    }
    throw new TasteBoardImportError(`manifest_read_failed:${path}`, {
      cause: error,
    });
  }
}

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase();
}

function parseMarkdown(markdown: string, path: string): MarkdownDocument {
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  if (!title) {
    throw new TasteBoardImportError(`invalid_markdown_title:${path}`);
  }

  const firstSection = markdown.search(/^##\s+/m);
  const preamble =
    firstSection >= 0 ? markdown.slice(0, firstSection) : markdown;
  const metadata = new Map<string, string>();
  const metadataPattern = /^-\s+(?:\*\*)?([^:\n*]+)(?:\*\*)?:\s*(.*)$/gm;
  for (const match of preamble.matchAll(metadataPattern)) {
    const key = match[1]?.trim().toLowerCase();
    if (key) {
      metadata.set(key, match[2]?.trim() ?? "");
    }
  }

  const sections = new Map<string, string>();
  const headings = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  for (const [index, match] of headings.entries()) {
    const heading = match[1];
    if (!heading || match.index === undefined) continue;
    const contentStart = match.index + match[0].length;
    const contentEnd = headings[index + 1]?.index ?? markdown.length;
    sections.set(
      normalizeHeading(heading),
      markdown.slice(contentStart, contentEnd).trim(),
    );
  }

  const parsed = markdownDocumentSchema.safeParse({
    title,
    metadata,
    sections,
  });
  if (!parsed.success) {
    throw new TasteBoardImportError(`invalid_markdown:${path}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function requireSection(
  document: MarkdownDocument,
  heading: string,
  path: string,
): string {
  const value = document.sections.get(normalizeHeading(heading));
  if (!value) {
    throw new TasteBoardImportError(
      `missing_markdown_section:${path}:${heading}`,
    );
  }
  return value;
}

function parseList(value: string): string[] {
  const backtickValues = [...value.matchAll(/`([^`]+)`/g)].map(
    (match) => match[1]?.trim() ?? "",
  );
  if (backtickValues.length > 0) {
    return backtickValues.flatMap((item) =>
      item
        .split(/,\s*/)
        .map((part) => part.trim())
        .filter(Boolean),
    );
  }
  return value
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

function mimeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  const types: Readonly<Record<string, string>> = {
    ".gif": "image/gif",
    ".html": "text/html",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".json": "application/json",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".txt": "text/plain",
    ".webm": "video/webm",
  };
  return types[extension] ?? "application/octet-stream";
}

function confidenceFromStatus(status: InspirationSeed["sourceStatus"]): string {
  if (status === "captured") return "high";
  if (status === "partial") return "medium";
  return "low";
}

function parseInspirationSeeds(repoRoot: string): InspirationSeed[] {
  const seeds: InspirationSeed[] = [];
  for (const manifestPath of INSPIRATION_MANIFESTS) {
    const manifest = readValidatedJson(
      repoRoot,
      manifestPath,
      inspirationManifestSchema,
    );
    for (const entry of manifest) {
      containedPath(repoRoot, entry.entry_path);
      for (const evidencePath of entry.evidence_paths) {
        containedPath(repoRoot, evidencePath);
      }
      const markdown = readFileSync(
        containedPath(repoRoot, entry.entry_path),
        "utf8",
      );
      const document = parseMarkdown(markdown, entry.entry_path);
      const vocabulary = parseList(
        requireSection(document, "Visual vocabulary", entry.entry_path),
      );
      const tags = parseList(
        requireSection(document, "Taste Board tags", entry.entry_path),
      );
      seeds.push({
        sourceUrl: entry.original_url,
        resolvedUrl: entry.resolved_url,
        title: document.title,
        purpose: requireSection(
          document,
          "What it is and does",
          entry.entry_path,
        ),
        aestheticFamily: requireSection(
          document,
          "Aesthetic family",
          entry.entry_path,
        ),
        vocabulary,
        brief: requireSection(
          document,
          "Copy-ready design brief",
          entry.entry_path,
        ),
        captureType: entry.capture_type,
        confidence: confidenceFromStatus(entry.status),
        sourceStatus: entry.status,
        limitation: entry.limitation,
        provenancePath: entry.entry_path,
        evidencePaths: entry.evidence_paths,
        tags,
      });
    }
  }
  return seeds;
}

function upsertInspiration(
  database: Database,
  seed: InspirationSeed,
  repoRoot: string,
  now: string,
): void {
  const id = stableId("inspiration", seed.provenancePath);
  database
    .query(
      `INSERT INTO inspirations (
        id, source_url, resolved_url, title, purpose, aesthetic_family,
        visual_vocabulary, brief, capture_type, confidence, source_status,
        provenance_path, limitation, created_at, updated_at
      ) VALUES (
        $id, $sourceUrl, $resolvedUrl, $title, $purpose, $aestheticFamily,
        $vocabulary, $brief, $captureType, $confidence, $sourceStatus,
        $provenancePath, $limitation, $now, $now
      )
      ON CONFLICT(provenance_path) DO UPDATE SET
        source_url = excluded.source_url,
        resolved_url = excluded.resolved_url,
        title = excluded.title,
        purpose = excluded.purpose,
        aesthetic_family = excluded.aesthetic_family,
        visual_vocabulary = excluded.visual_vocabulary,
        brief = excluded.brief,
        capture_type = excluded.capture_type,
        confidence = excluded.confidence,
        source_status = excluded.source_status,
        limitation = excluded.limitation,
        updated_at = excluded.updated_at`,
    )
    .run({
      id,
      sourceUrl: seed.sourceUrl,
      resolvedUrl: seed.resolvedUrl,
      title: seed.title,
      purpose: seed.purpose,
      aestheticFamily: seed.aestheticFamily,
      vocabulary: JSON.stringify(seed.vocabulary),
      brief: seed.brief,
      captureType: seed.captureType,
      confidence: seed.confidence,
      sourceStatus: seed.sourceStatus,
      provenancePath: seed.provenancePath,
      limitation: seed.limitation,
      now,
    });

  const persisted = database
    .query<{ id: string }, [string]>(
      "SELECT id FROM inspirations WHERE provenance_path = ?",
    )
    .get(seed.provenancePath);
  if (!persisted) {
    throw new TasteBoardImportError(
      `persisted_inspiration_missing:${seed.provenancePath}`,
    );
  }
  const persistedId = persisted.id;

  database
    .query(
      "DELETE FROM inspiration_tags WHERE inspiration_id = ? AND source = 'seed'",
    )
    .run(persistedId);
  for (const name of seed.tags) {
    const tagId = stableId("tag", name.toLocaleLowerCase("en-US"));
    database
      .query(
        `INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET name = excluded.name`,
      )
      .run(tagId, name, now);
    database
      .query(
        `INSERT INTO inspiration_tags (inspiration_id, tag_id, source)
         VALUES (?, ?, 'seed') ON CONFLICT DO NOTHING`,
      )
      .run(persistedId, tagId);
  }

  database
    .query(
      "DELETE FROM inspiration_assets WHERE inspiration_id = ? AND source = 'seed'",
    )
    .run(persistedId);
  for (const path of seed.evidencePaths) {
    const absolutePath = containedPath(repoRoot, path);
    const available = existsSync(absolutePath);
    const contentHash = available
      ? createHash("sha256").update(readFileSync(absolutePath)).digest("hex")
      : null;
    database
      .query(
        `INSERT INTO inspiration_assets (
          id, inspiration_id, content_hash, relative_path, mime_type, role,
          source, is_available, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'seed', ?, ?)
        ON CONFLICT(inspiration_id, relative_path, role) DO NOTHING`,
      )
      .run(
        stableId("asset", path),
        persistedId,
        contentHash,
        path,
        mimeForPath(path),
        "provenance",
        available ? 1 : 0,
        now,
      );
  }
}

function markdownSection(
  document: MarkdownDocument,
  heading: string,
  path: string,
): string {
  return requireSection(document, heading, path);
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function importCategories(
  database: Database,
  repoRoot: string,
  now: string,
): number {
  const manifest = readValidatedJson(
    repoRoot,
    CATEGORY_MANIFEST,
    categoryManifestSchema,
  );
  const actualDocuments = manifest.documents.filter(
    ({ document }) => document !== STILLNESS_EXAMPLE,
  );
  for (const item of actualDocuments) {
    containedPath(repoRoot, item.document);
    for (const evidencePath of item.evidence) {
      containedPath(repoRoot, evidencePath);
    }
    const markdown = readFileSync(
      containedPath(repoRoot, item.document),
      "utf8",
    );
    const document = parseMarkdown(markdown, item.document);
    const slug = slugify(document.title);
    const inclusionRules = markdownSection(
      document,
      "Inclusion signals",
      item.document,
    );
    const exclusionRules = markdownSection(
      document,
      "Exclusion signals",
      item.document,
    );
    const description = markdownSection(
      document,
      "Recognizable visual logic",
      item.document,
    );
    database
      .query(
        `INSERT INTO categories (
          id, slug, name, description, inclusion_rules, exclusion_rules,
          is_provisional, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          slug = excluded.slug,
          name = excluded.name,
          description = excluded.description,
          inclusion_rules = excluded.inclusion_rules,
          exclusion_rules = excluded.exclusion_rules,
          is_provisional = 1,
          updated_at = excluded.updated_at`,
      )
      .run(
        stableId("category", item.document),
        slug,
        document.title,
        description,
        inclusionRules,
        exclusionRules,
        now,
        now,
      );
  }
  return actualDocuments.length;
}

export function importTasteBoard(
  database: Database,
  repoRoot: string,
): TasteBoardImportResult {
  let seeds: InspirationSeed[];
  try {
    seeds = parseInspirationSeeds(repoRoot);
  } catch (error) {
    if (error instanceof TasteBoardImportError) throw error;
    throw new TasteBoardImportError("source_parse_failed", { cause: error });
  }
  if (seeds.length !== 18) {
    throw new TasteBoardImportError(
      `unexpected_inspiration_count:${seeds.length}`,
    );
  }

  const execute = database.transaction((): TasteBoardImportResult => {
    const now = new Date().toISOString();
    for (const seed of seeds) {
      upsertInspiration(database, seed, repoRoot, now);
    }
    const categories = importCategories(database, repoRoot, now);
    if (categories !== 4) {
      throw new TasteBoardImportError(
        `unexpected_category_count:${categories}`,
      );
    }
    return { inspirations: seeds.length, categories };
  });

  try {
    return execute.immediate();
  } catch (error) {
    if (error instanceof TasteBoardImportError) throw error;
    throw new TasteBoardImportError("transaction_failed", { cause: error });
  }
}
