import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrateDatabase } from "../../src/server/database";
import { LibraryStore, StoreError } from "../../src/server/store";

const MARKDOWN = `# Quiet interface

## Aesthetic family
Editorial minimalism

## Visual vocabulary
- restrained
- tactile
- spacious
- typographic
- warm

## References and borrowed qualities
- Print hierarchy

## Intent
Make comparison calm.

## Audience
Designers

## Primary action
Compare variants

## Always
- Preserve hierarchy

## Never
- Add visual noise

## Open risks
- Low contrast

## Final copy-ready generation prompt
Build a calm comparison interface.
`;

function setup(): { database: Database; store: LibraryStore } {
  const database = new Database(":memory:", { strict: true });
  migrateDatabase(database);
  return {
    database,
    store: new LibraryStore(database, () => "2026-07-24T12:00:00.000Z"),
  };
}

function inspiration(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "inspiration-one",
    sourceUrl: "https://example.com/work/one",
    title: "Quiet Print",
    captureType: "screenshot",
    confidence: "high",
    sourceStatus: "captured",
    visualVocabulary: ["quiet", "paper"],
    tags: ["Editorial", "Paper"],
    categoryIds: ["category-one"],
    ...overrides,
  };
}

describe("LibraryStore", () => {
  test("creates, hydrates, filters, and replaces joins", () => {
    const { database, store } = setup();
    store.createCategory({
      id: "category-one",
      slug: "print-tech",
      name: "Print Tech",
      isProvisional: true,
    });
    store.createCategory({
      id: "category-two",
      slug: "cinematic",
      name: "Cinematic",
    });

    const created = store.createInspiration(inspiration());
    expect(created.tags).toEqual(["Editorial", "Paper"]);
    expect(created.categories.map(({ slug }) => slug)).toEqual(["print-tech"]);
    expect(created.assets).toEqual([]);
    expect(store.listInspirations({ q: "Quiet" })).toHaveLength(1);
    expect(store.listInspirations({ category: "print-tech" })).toHaveLength(1);
    expect(store.listInspirations({ tag: "editorial" })).toHaveLength(1);
    expect(store.listInspirations({ source: "example.com" })).toHaveLength(1);
    expect(
      store.listInspirations({ source: "https://example.com/anything" }),
    ).toHaveLength(1);
    expect(store.listInspirations({ sourceStatus: "blocked" })).toHaveLength(0);

    const updated = store.updateInspiration("inspiration-one", {
      title: "Quiet Cinema",
      tags: ["Motion"],
      categoryIds: ["category-two"],
    });
    expect(updated.tags).toEqual(["Motion"]);
    expect(updated.categories.map(({ slug }) => slug)).toEqual(["cinematic"]);
    expect(store.listInspirations({ tag: "Paper" })).toHaveLength(0);
    expect(store.listInspirations({ category: "cinematic" })).toHaveLength(1);
    database.close();
  });

  test("registers assets idempotently and rejects cross-inspiration paths", () => {
    const { database, store } = setup();
    store.createCategory({
      id: "category-one",
      slug: "print-tech",
      name: "Print Tech",
    });
    store.createInspiration(inspiration());
    store.createInspiration(
      inspiration({
        id: "inspiration-two",
        sourceUrl: "https://example.com/work/two",
        provenancePath: "manual/two",
      }),
    );
    const hash = "a".repeat(64);
    const first = store.addInspirationAsset("inspiration-one", {
      contentHash: hash,
      relativePath: "uploads/example.png",
      mimeType: "image/png",
      role: "primary",
    });
    expect(first.assets).toEqual([
      {
        id: first.assets[0]?.id,
        relativePath: "uploads/example.png",
        mimeType: "image/png",
        role: "primary",
        contentHash: hash,
        isAvailable: true,
        motionTimestampMs: null,
      },
    ]);

    const updated = store.addInspirationAsset("inspiration-one", {
      contentHash: "b".repeat(64),
      relativePath: "uploads/example.png",
      mimeType: "image/png",
      role: "primary",
      motionTimestampMs: 250,
    });
    expect(updated.assets).toHaveLength(1);
    expect(updated.assets[0]?.contentHash).toBe("b".repeat(64));
    expect(updated.assets[0]?.motionTimestampMs).toBe(250);

    expect(() =>
      store.addInspirationAsset("inspiration-two", {
        contentHash: hash,
        relativePath: "uploads/example.png",
        mimeType: "image/png",
        role: "primary",
      }),
    ).toThrow(StoreError);
    expect(() =>
      store.addInspirationAsset("inspiration-one", {
        contentHash: "not-a-hash",
        relativePath: "../escape.png",
        mimeType: "image/png",
        role: "primary",
      }),
    ).toThrow(StoreError);
    expect(store.getInspiration("inspiration-two").assets).toEqual([]);
    database.close();
  });

  test("uses stable invalid, conflict, and not_found errors", () => {
    const { database, store } = setup();
    expect(() => store.listInspirations({ madeUp: true })).toThrow(StoreError);
    try {
      store.getInspiration("missing");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreError);
      expect((error as StoreError).code).toBe("not_found");
    }

    store.createCategory({
      id: "category-one",
      slug: "print-tech",
      name: "Print Tech",
    });
    store.createInspiration(inspiration());
    try {
      store.createInspiration(
        inspiration({ id: "other", provenancePath: "other.md" }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(StoreError);
      expect((error as StoreError).code).toBe("conflict");
    }
    database.close();
  });

  test("renames and retires categories without changing provisional status", () => {
    const { database, store } = setup();
    store.createCategory({
      id: "category-one",
      slug: "print-tech",
      name: "Print Tech",
      isProvisional: true,
    });
    const category = store.updateCategory("category-one", {
      slug: "paper-systems",
      name: "Paper Systems",
      isRetired: true,
    });
    expect(category.isProvisional).toBe(true);
    expect(category.isRetired).toBe(true);
    expect(store.listCategories()).toEqual([]);
    expect(store.listCategories({ includeRetired: true })[0]?.slug).toBe(
      "paper-systems",
    );
    database.close();
  });

  test("validates canonical briefs and persists the parsed final prompt", () => {
    const { database, store } = setup();
    const saved = store.createBrief({
      id: "brief-one",
      slug: "quiet-interface",
      markdown: MARKDOWN,
    });
    expect(saved.title).toBe("Quiet interface");
    expect(saved.finalPrompt).toBe("Build a calm comparison interface.");
    expect(store.getBrief("quiet-interface")).toEqual(saved);
    expect(store.listBriefs()).toEqual([saved]);

    expect(() =>
      store.updateBrief("brief-one", {
        markdown: "# Invalid replacement",
      }),
    ).toThrow(StoreError);
    expect(store.getBrief("brief-one").markdown).toBe(MARKDOWN.trim());

    try {
      store.createBrief({
        slug: "invalid",
        markdown: "# Invalid",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(StoreError);
      expect((error as StoreError).code).toBe("invalid");
    }
    database.close();
  });

  test("rejects ambiguous brief id and slug lookups without updating either row", () => {
    const { database, store } = setup();
    store.createBrief({
      id: "brief-by-id",
      slug: "shared-lookup",
      markdown: MARKDOWN,
    });
    store.createBrief({
      id: "shared-lookup",
      slug: "other-slug",
      markdown: MARKDOWN.replace("Quiet interface", "Other interface"),
    });

    try {
      store.getBrief("shared-lookup");
      throw new Error("expected ambiguous lookup conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreError);
      expect((error as StoreError).code).toBe("conflict");
    }
    expect(() =>
      store.updateBrief("shared-lookup", { slug: "changed" }),
    ).toThrow(StoreError);
    expect(
      database
        .query<{ slug: string }, [string]>(
          "SELECT slug FROM briefs WHERE id = ?",
        )
        .get("brief-by-id"),
    ).toEqual({ slug: "shared-lookup" });
    expect(
      database
        .query<{ slug: string }, [string]>(
          "SELECT slug FROM briefs WHERE id = ?",
        )
        .get("shared-lookup"),
    ).toEqual({ slug: "other-slug" });
    database.close();
  });

  test("reports unique category and brief slugs as conflicts", () => {
    const { database, store } = setup();
    store.createCategory({ slug: "quiet", name: "Quiet" });
    expect(() =>
      store.createCategory({ slug: "quiet", name: "Another" }),
    ).toThrow(StoreError);
    store.createBrief({ slug: "quiet", markdown: MARKDOWN });
    try {
      store.createBrief({ slug: "quiet", markdown: MARKDOWN });
    } catch (error) {
      expect((error as StoreError).code).toBe("conflict");
    }
    database.close();
  });
});
