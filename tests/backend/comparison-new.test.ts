import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ComparisonError,
  createComparison,
  getComparison,
  listComparisons,
  type ComparisonPacket,
  updateComparison,
} from "../../src/server/comparisons";
import { migrateDatabase } from "../../src/server/database";

const TEMP_ROOT = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/comparison-new-tests",
);
const createdDirectories: string[] = [];

const VALID_BRIEF = `# Quiet Editorial

## Aesthetic family
Editorial minimalism

## Visual vocabulary
- quiet
- precise
- spacious
- typographic
- tactile

## References and borrowed qualities
- Print layouts with disciplined rhythm

## Intent
Create a calm comparison workspace.

## Audience
Design reviewers.

## Primary action
Compare variants.

## Always
- Preserve readable hierarchy

## Never
- Add ornamental noise

## Open risks
- Excessive whitespace

## Final copy-ready generation prompt
Build a quiet editorial comparison page.
`;

function fixture(): {
  database: Database;
  briefPath: string;
  generatedRoot: string;
} {
  const runRoot = resolve(TEMP_ROOT, crypto.randomUUID());
  const generatedRoot = resolve(runRoot, "generated-variants");
  const briefPath = resolve(runRoot, "brief.md");
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(briefPath, VALID_BRIEF, "utf8");
  createdDirectories.push(runRoot);
  const database = new Database(":memory:", { strict: true });
  migrateDatabase(database);
  return { database, briefPath, generatedRoot };
}

afterEach(() => {
  const archiveRoot = resolve(TEMP_ROOT, "_archive");
  mkdirSync(archiveRoot, { recursive: true });
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (!directory) continue;
    Bun.spawnSync([
      "mv",
      directory,
      resolve(archiveRoot, `${crypto.randomUUID()}`),
    ]);
  }
});

describe("comparison creation", () => {
  test("creates packet, engine directories, and database rows", () => {
    const { database, briefPath, generatedRoot } = fixture();
    const result = createComparison(database, {
      brief: briefPath,
      directions: 3,
      generatedRoot,
    });

    const packet = JSON.parse(
      readFileSync(result.packetPath, "utf8"),
    ) as ComparisonPacket;
    expect(packet.sourceBrief.parsed.title).toBe("Quiet Editorial");
    expect(packet.directions.map((direction) => direction.position)).toEqual([
      0, 1, 2,
    ]);
    for (const direction of result.directions) {
      expect(
        existsSync(resolve(result.directory, direction.slug, "impeccable")),
      ).toBe(true);
      expect(
        existsSync(resolve(result.directory, direction.slug, "taste")),
      ).toBe(true);
    }
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM comparisons",
        )
        .get()?.count,
    ).toBe(1);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM aesthetic_directions",
        )
        .get()?.count,
    ).toBe(3);
    database.close();
  });

  test("rejects more than five directions without mutation", () => {
    const { database, briefPath, generatedRoot } = fixture();
    expect(() =>
      createComparison(database, {
        brief: briefPath,
        directions: 6,
        generatedRoot,
      }),
    ).toThrow(ComparisonError);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM comparisons",
        )
        .get()?.count,
    ).toBe(0);
    database.close();
  });

  test("resolves an existing database brief by id", () => {
    const { database, briefPath, generatedRoot } = fixture();
    const first = createComparison(database, {
      brief: briefPath,
      directions: 1,
      generatedRoot,
    });
    const briefId = database
      .query<{ id: string }, []>("SELECT id FROM briefs LIMIT 1")
      .get()?.id;
    expect(briefId).toBeDefined();
    const second = createComparison(database, {
      brief: briefId,
      directions: 1,
      generatedRoot,
    });
    expect(second.comparisonId).not.toBe(first.comparisonId);
    database.close();
  });

  test("rejects missing and malformed briefs", () => {
    const { database, generatedRoot } = fixture();
    expect(() =>
      createComparison(database, {
        brief: "missing-brief",
        directions: 1,
        generatedRoot,
      }),
    ).toThrow("No brief exists");

    const malformedPath = resolve(dirname(generatedRoot), "malformed.md");
    writeFileSync(malformedPath, "# Not canonical\n", "utf8");
    expect(() =>
      createComparison(database, {
        brief: malformedPath,
        directions: 1,
        generatedRoot,
      }),
    ).toThrow("Design brief validation failed");
    database.close();
  });

  test("CLI emits a stable JSON error and nonzero exit for invalid input", () => {
    const runRoot = resolve(TEMP_ROOT, crypto.randomUUID());
    mkdirSync(runRoot, { recursive: true });
    createdDirectories.push(runRoot);
    const command = Bun.spawnSync({
      cmd: [
        process.execPath,
        "run",
        "scripts/comparison-new.ts",
        "--brief",
        "missing-brief",
        "--directions",
        "6",
        "--db",
        resolve(runRoot, "workbench.sqlite"),
        "--generated-root",
        resolve(runRoot, "generated-variants"),
      ],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(command.exitCode).toBe(1);
    expect(JSON.parse(command.stderr.toString())).toMatchObject({
      error: {
        code: "INVALID_CLI_ARGUMENTS",
        message: "CLI arguments are invalid",
      },
    });
    expect(command.stdout.toString()).toBe("");
  });

  test("CLI help states the artifact-only operator boundary", () => {
    const command = Bun.spawnSync({
      cmd: [process.execPath, "run", "scripts/comparison-new.ts", "--help"],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(command.exitCode).toBe(0);
    expect(command.stdout.toString()).toContain("bun run comparison:new");
    expect(command.stdout.toString()).toContain("does not invoke a model");
    expect(command.stderr.toString()).toBe("");
  });

  test("lists and gets hydrated comparisons with ordered variants", () => {
    const { database, briefPath, generatedRoot } = fixture();
    const created = createComparison(database, {
      brief: briefPath,
      directions: 2,
      generatedRoot,
    });
    const secondDirection = created.directions[1];
    const firstDirection = created.directions[0];
    if (!firstDirection || !secondDirection) {
      throw new Error("Expected two directions");
    }
    const now = "2026-07-24T12:00:00.000Z";
    const insertVariant = database.query(
      `INSERT INTO variants (
        id, direction_id, engine, artifact_path, viewport, metadata,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertVariant.run(
      "taste-variant",
      firstDirection.id,
      "taste",
      "first/taste",
      '{"width":1280}',
      '{"quality":"draft"}',
      now,
      now,
    );
    insertVariant.run(
      "impeccable-variant",
      firstDirection.id,
      "impeccable",
      "first/impeccable",
      '{"width":1280}',
      '{"quality":"reviewed"}',
      now,
      now,
    );

    const listed = listComparisons(database);
    expect(listed).toHaveLength(1);
    expect(
      listed[0]?.directions.map((direction) => direction.position),
    ).toEqual([0, 1]);
    expect(
      listed[0]?.directions[0]?.variants.map((variant) => variant.engine),
    ).toEqual(["impeccable", "taste"]);
    expect(listed[0]?.directions[0]?.variants[0]?.viewport).toEqual({
      width: 1280,
    });
    const bySlug = getComparison(database, listed[0]?.slug);
    expect(bySlug.id).toBe(created.comparisonId);
    database.close();
  });

  test("updates only title and status and rejects invalid patches", () => {
    const { database, briefPath, generatedRoot } = fixture();
    const created = createComparison(database, {
      brief: briefPath,
      directions: 1,
      generatedRoot,
    });
    const updated = updateComparison(database, created.comparisonId, {
      title: "Reviewed direction",
      status: "ready",
    });
    expect(updated.title).toBe("Reviewed direction");
    expect(updated.status).toBe("ready");
    expect(() =>
      updateComparison(database, created.comparisonId, {
        slug: "forbidden",
      }),
    ).toThrow("Comparison input is invalid");
    expect(() => updateComparison(database, created.comparisonId, {})).toThrow(
      "Comparison input is invalid",
    );
    expect(() => getComparison(database, "missing")).toThrow(
      "No comparison exists",
    );
    database.close();
  });

  test("rejects a stale comparison update without overwriting the newer value", () => {
    const { database, briefPath, generatedRoot } = fixture();
    const created = createComparison(database, {
      brief: briefPath,
      directions: 1,
      generatedRoot,
    });

    try {
      updateComparison(
        database,
        created.comparisonId,
        { title: "Stale writer" },
        {
          beforeWrite: () => {
            database
              .query(
                `UPDATE comparisons
                 SET title = ?, updated_at = ?
                 WHERE id = ?`,
              )
              .run(
                "Concurrent writer",
                "2099-01-01T00:00:00.000Z",
                created.comparisonId,
              );
          },
        },
      );
      throw new Error("Expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ComparisonError);
      expect((error as ComparisonError).code).toBe("COMPARISON_CONFLICT");
    }
    expect(getComparison(database, created.comparisonId).title).toBe(
      "Concurrent writer",
    );
    database.close();
  });

  test("rolls back a file brief when comparison persistence fails", () => {
    const { database, briefPath, generatedRoot } = fixture();
    database.exec(`
      CREATE TRIGGER reject_comparison_insert
      BEFORE INSERT ON comparisons
      BEGIN
        SELECT RAISE(ABORT, 'fixture comparison failure');
      END
    `);

    expect(() =>
      createComparison(database, {
        brief: briefPath,
        directions: 2,
        generatedRoot,
      }),
    ).toThrow("Comparison creation failed");

    for (const table of [
      "briefs",
      "comparisons",
      "aesthetic_directions",
    ] as const) {
      expect(
        database
          .query<{ count: number }, []>(
            `SELECT COUNT(*) AS count FROM ${table}`,
          )
          .get()?.count,
      ).toBe(0);
    }
    const activeEntries = existsSync(generatedRoot)
      ? Array.from(
          new Bun.Glob("*").scanSync({
            cwd: generatedRoot,
            onlyFiles: false,
          }),
        ).filter((entry) => entry !== "_archive")
      : [];
    expect(activeEntries).toEqual([]);
    database.close();
  });

  test("fails with a stable conflict for an ambiguous id or slug", () => {
    const { database, briefPath, generatedRoot } = fixture();
    const created = createComparison(database, {
      brief: briefPath,
      directions: 1,
      generatedRoot,
    });
    const first = getComparison(database, created.comparisonId);
    const now = "2026-07-24T12:00:00.000Z";
    database
      .query(
        `INSERT INTO comparisons (
          id, slug, title, source_brief_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        first.slug,
        "different-slug",
        "Ambiguous",
        first.sourceBriefId,
        "draft",
        now,
        now,
      );

    try {
      getComparison(database, first.slug);
      throw new Error("Expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ComparisonError);
      expect((error as ComparisonError).code).toBe("COMPARISON_CONFLICT");
    }
    database.close();
  });
});
