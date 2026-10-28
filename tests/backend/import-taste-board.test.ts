import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { migrateDatabase } from "../../src/server/database";
import {
  TasteBoardImportError,
  importTasteBoard,
} from "../../src/server/taste-board";
import { LibraryStore } from "../../src/server/store";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const TEST_TEMP_ROOT =
  process.env.DESIGN_WORKBENCH_TEST_TEMP ??
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/tests";

function database(): Database {
  const instance = new Database(":memory:", { strict: true });
  migrateDatabase(instance);
  return instance;
}

describe("taste board import", () => {
  test("imports exact source truth and remains idempotent", () => {
    const instance = database();
    expect(importTasteBoard(instance, REPO_ROOT)).toEqual({
      inspirations: 18,
      categories: 4,
    });
    expect(importTasteBoard(instance, REPO_ROOT)).toEqual({
      inspirations: 18,
      categories: 4,
    });

    expect(
      instance
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM inspirations",
        )
        .get()?.count,
    ).toBe(18);
    expect(
      instance
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM categories",
        )
        .get()?.count,
    ).toBe(4);
    expect(
      instance
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM categories WHERE slug = 'stillness-example'",
        )
        .get()?.count,
    ).toBe(0);
    expect(
      instance
        .query<{ source_status: string; limitation: string }, [string]>(
          `SELECT source_status, limitation FROM inspirations
         WHERE provenance_path = ?`,
        )
        .get("taste-board/inbox/batch-001/direct-sites/forai-design.md"),
    ).toEqual({
      source_status: "partial",
      limitation:
        "The required chrome-agent named browser could not create its local profile because of EPERM on the normal attempt and one retry, so no rendered full-page screenshot, interaction pass, or complete browser network timeline was available. Public metadata and HTML exposed direct MP4 media; one representative asset was analyzed and three frames were promoted.",
    });
    expect(
      instance
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM inspirations
         WHERE source_status = 'captured'`,
        )
        .get()?.count,
    ).toBe(6);
    expect(
      instance
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM inspirations
         WHERE source_status = 'partial'`,
        )
        .get()?.count,
    ).toBe(5);
    expect(
      instance
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM inspirations
         WHERE source_status = 'blocked'`,
        )
        .get()?.count,
    ).toBe(7);
    expect(
      instance
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count
         FROM inspiration_tags it
         JOIN inspirations i ON i.id = it.inspiration_id
         WHERE i.provenance_path =
           'taste-board/inbox/batch-001/pinterest/pin-1.md'`,
        )
        .get()?.count,
    ).toBeGreaterThan(4);
    expect(
      instance
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM inspiration_assets
         WHERE (content_hash IS NULL AND is_available != 0)
            OR (content_hash IS NOT NULL AND is_available != 1)`,
        )
        .get()?.count,
    ).toBe(0);
    instance.close();
  });

  test("preserves user tags and uploads across a repeated import", () => {
    const instance = database();
    importTasteBoard(instance, REPO_ROOT);
    const inspiration = instance
      .query<{ id: string }, [string]>(
        "SELECT id FROM inspirations WHERE provenance_path = ?",
      )
      .get("taste-board/inbox/batch-001/pinterest/pin-1.md");
    expect(inspiration).toBeDefined();
    if (!inspiration) throw new Error("fixture inspiration was not imported");

    instance
      .query("INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)")
      .run("user-tag", "User Curated", "2026-07-24T00:00:00.000Z");
    instance
      .query(
        `INSERT INTO inspiration_tags (inspiration_id, tag_id, source)
         VALUES (?, ?, 'user')`,
      )
      .run(inspiration.id, "user-tag");
    instance
      .query(
        `INSERT INTO inspiration_assets (
          id, inspiration_id, content_hash, relative_path, mime_type, role,
          source, is_available, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'user', 1, ?)`,
      )
      .run(
        "user-upload",
        inspiration.id,
        "a".repeat(64),
        "uploads/user-curated.png",
        "image/png",
        "provenance",
        "2026-07-24T00:00:00.000Z",
      );

    importTasteBoard(instance, REPO_ROOT);

    expect(
      instance
        .query<{ source: string }, [string, string]>(
          `SELECT source FROM inspiration_tags
           WHERE inspiration_id = ? AND tag_id = ?`,
        )
        .get(inspiration.id, "user-tag"),
    ).toEqual({ source: "user" });
    expect(
      instance
        .query<{ role: string; source: string }, [string]>(
          "SELECT role, source FROM inspiration_assets WHERE id = ?",
        )
        .get("user-upload"),
    ).toEqual({ role: "provenance", source: "user" });
    expect(
      instance
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM inspiration_assets
           WHERE inspiration_id = ? AND source = 'seed'`,
        )
        .get(inspiration.id)?.count,
    ).toBeGreaterThan(0);
    instance.close();
  });

  test("promotes an overwritten seed asset to user ownership across reimport", () => {
    const instance = database();
    importTasteBoard(instance, REPO_ROOT);
    const seedAsset = instance
      .query<
        {
          inspiration_id: string;
          relative_path: string;
          role: string;
        },
        []
      >(
        `SELECT inspiration_id, relative_path, role
         FROM inspiration_assets WHERE source = 'seed'
         ORDER BY inspiration_id, relative_path LIMIT 1`,
      )
      .get();
    expect(seedAsset).toBeDefined();
    if (!seedAsset) throw new Error("seed asset was not imported");

    const userHash = "b".repeat(64);
    const store = new LibraryStore(instance, () => "2026-07-24T12:00:00.000Z");
    store.addInspirationAsset(seedAsset.inspiration_id, {
      contentHash: userHash,
      relativePath: seedAsset.relative_path,
      mimeType: "image/png",
      role: seedAsset.role,
    });
    expect(
      instance
        .query<
          { content_hash: string | null; source: string },
          [string, string, string]
        >(
          `SELECT content_hash, source FROM inspiration_assets
           WHERE inspiration_id = ? AND relative_path = ? AND role = ?`,
        )
        .get(seedAsset.inspiration_id, seedAsset.relative_path, seedAsset.role),
    ).toEqual({ content_hash: userHash, source: "user" });

    importTasteBoard(instance, REPO_ROOT);

    expect(
      instance
        .query<
          { content_hash: string | null; source: string },
          [string, string, string]
        >(
          `SELECT content_hash, source FROM inspiration_assets
           WHERE inspiration_id = ? AND relative_path = ? AND role = ?`,
        )
        .get(seedAsset.inspiration_id, seedAsset.relative_path, seedAsset.role),
    ).toEqual({ content_hash: userHash, source: "user" });
    instance.close();
  });

  test("uses the persisted id when provenance already exists", () => {
    const instance = database();
    const provenance = "taste-board/inbox/batch-001/pinterest/pin-1.md";
    instance
      .query(
        `INSERT INTO inspirations (
          id, source_url, title, capture_type, confidence, source_status,
          provenance_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "preexisting-custom-id",
        "https://www.pinterest.com/pin/1055599900055291/",
        "Old title",
        "unknown",
        "low",
        "partial",
        provenance,
        "2026-07-24T00:00:00.000Z",
        "2026-07-24T00:00:00.000Z",
      );

    expect(importTasteBoard(instance, REPO_ROOT).inspirations).toBe(18);
    expect(
      instance
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM inspiration_tags
           WHERE inspiration_id = ?`,
        )
        .get("preexisting-custom-id")?.count,
    ).toBeGreaterThan(0);
    expect(
      instance
        .query<{ count: number }, [string]>(
          `SELECT COUNT(*) AS count FROM inspiration_assets
           WHERE inspiration_id = ?`,
        )
        .get("preexisting-custom-id")?.count,
    ).toBeGreaterThan(0);
    instance.close();
  });

  test("updates a category by source-document identity when its slug changes", () => {
    const instance = database();
    importTasteBoard(instance, REPO_ROOT);
    const category = instance
      .query<{ id: string; slug: string }, []>(
        "SELECT id, slug FROM categories ORDER BY slug LIMIT 1",
      )
      .get();
    expect(category).toBeDefined();
    if (!category) throw new Error("fixture category was not imported");

    instance
      .query("UPDATE categories SET slug = ?, name = ? WHERE id = ?")
      .run(`old-${category.slug}`, `Old ${category.slug}`, category.id);

    expect(importTasteBoard(instance, REPO_ROOT)).toEqual({
      inspirations: 18,
      categories: 4,
    });
    expect(
      instance
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM categories WHERE id = ?",
        )
        .get(category.id)?.count,
    ).toBe(1);
    expect(
      instance
        .query<{ slug: string }, [string]>(
          "SELECT slug FROM categories WHERE id = ?",
        )
        .get(category.id),
    ).toEqual({ slug: category.slug });
    instance.close();
  });

  test("fails closed when a category slug belongs to an unrelated row", () => {
    const instance = database();
    importTasteBoard(instance, REPO_ROOT);
    const category = instance
      .query<{ id: string; slug: string }, []>(
        "SELECT id, slug FROM categories ORDER BY slug LIMIT 1",
      )
      .get();
    expect(category).toBeDefined();
    if (!category) throw new Error("fixture category was not imported");

    instance
      .query("UPDATE categories SET slug = ?, name = ? WHERE id = ?")
      .run(`old-${category.slug}`, `Old ${category.slug}`, category.id);
    instance
      .query(
        `INSERT INTO categories (
          id, slug, name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "unrelated-category",
        category.slug,
        "Unrelated category",
        "2026-07-24T00:00:00.000Z",
        "2026-07-24T00:00:00.000Z",
      );

    expect(() => importTasteBoard(instance, REPO_ROOT)).toThrow(
      TasteBoardImportError,
    );
    expect(
      instance
        .query<{ name: string }, [string]>(
          "SELECT name FROM categories WHERE id = ?",
        )
        .get("unrelated-category"),
    ).toEqual({ name: "Unrelated category" });
    instance.close();
  });

  test("rejects a manifest path outside the repository", () => {
    mkdirSync(TEST_TEMP_ROOT, { recursive: true });
    const fixtureRoot = mkdtempSync(
      join(TEST_TEMP_ROOT, "taste-board-invalid-"),
    );
    cpSync(join(REPO_ROOT, "taste-board"), join(fixtureRoot, "taste-board"), {
      recursive: true,
    });
    const manifestPath = join(
      fixtureRoot,
      "taste-board/inbox/batch-001/pinterest/manifest.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Array<
      Record<string, unknown>
    >;
    if (manifest[0]) manifest[0].entry_path = "../outside.md";
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    const instance = database();
    expect(() => importTasteBoard(instance, fixtureRoot)).toThrow(
      TasteBoardImportError,
    );
    expect(
      instance
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM inspirations",
        )
        .get()?.count,
    ).toBe(0);
    instance.close();
  });

  test("rejects existing evidence reached through an escaping symlink", () => {
    mkdirSync(TEST_TEMP_ROOT, { recursive: true });
    const fixtureRoot = mkdtempSync(
      join(TEST_TEMP_ROOT, "taste-board-symlink-"),
    );
    cpSync(join(REPO_ROOT, "taste-board"), join(fixtureRoot, "taste-board"), {
      recursive: true,
    });
    const outsideEvidence = join(
      TEST_TEMP_ROOT,
      `outside-evidence-${fixtureRoot.split("-").at(-1)}.jpg`,
    );
    writeFileSync(outsideEvidence, "not repository evidence", "utf8");
    const linkedEvidence = join(fixtureRoot, "linked-evidence.jpg");
    symlinkSync(outsideEvidence, linkedEvidence);

    const manifestPath = join(
      fixtureRoot,
      "taste-board/inbox/batch-001/pinterest/manifest.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Array<
      Record<string, unknown>
    >;
    if (manifest[0]) manifest[0].evidence_paths = ["linked-evidence.jpg"];
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    const instance = database();
    expect(() => importTasteBoard(instance, fixtureRoot)).toThrow(
      TasteBoardImportError,
    );
    expect(
      instance
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM inspirations",
        )
        .get()?.count,
    ).toBe(0);
    instance.close();
  });
});
