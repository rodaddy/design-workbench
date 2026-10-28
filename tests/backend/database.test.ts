import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DATABASE_MIGRATION_ERROR,
  DatabaseMigrationError,
  migrateDatabase,
} from "../../src/server/database";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const TEST_TEMP_ROOT =
  process.env.DESIGN_WORKBENCH_TEST_TEMP ??
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/tests";

function migratedDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  migrateDatabase(database);
  return database;
}

function insertInspiration(database: Database, id = "inspiration-1"): void {
  database
    .query(
      `INSERT INTO inspirations (
        id, source_url, title, capture_type, confidence, source_status,
        provenance_path, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      `https://example.com/${id}`,
      "Example",
      "screenshot",
      "captured",
      "captured",
      `tests/${id}.md`,
      "2026-07-24T00:00:00.000Z",
      "2026-07-24T00:00:00.000Z",
    );
}

describe("database migrations", () => {
  test("apply once and remain idempotent", () => {
    const database = migratedDatabase();
    const applied = () =>
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM schema_migrations",
        )
        .get()?.count;

    // Every migration on disk is applied. The count is read rather than
    // hardcoded so adding a migration does not falsely fail an idempotency
    // test that is really about re-running being a no-op.
    const first = applied();
    expect(first).toBeGreaterThanOrEqual(2);

    migrateDatabase(database);

    expect(applied()).toBe(first);
    insertInspiration(database);
    expect(
      database
        .query<{ title: string }, [string]>(
          "SELECT title FROM inspirations WHERE id = ?",
        )
        .get("inspiration-1"),
    ).toEqual({ title: "Example" });
    database.close();
  });

  test("enforces foreign keys for relationships", () => {
    const database = migratedDatabase();

    expect(() =>
      database
        .query(
          `INSERT INTO inspiration_assets (
            id, inspiration_id, content_hash, relative_path, mime_type, role,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "asset-1",
          "missing",
          "abc123",
          "uploads/abc123.png",
          "image/png",
          "primary",
          "2026-07-24T00:00:00.000Z",
        ),
    ).toThrow();
    database.close();
  });

  test("enforces idempotency keys and comparison direction positions", () => {
    const database = migratedDatabase();
    insertInspiration(database);

    expect(() => insertInspiration(database, "inspiration-1")).toThrow();
    expect(() => {
      database
        .query(
          `INSERT INTO inspirations (
            id, source_url, title, capture_type, confidence, source_status,
            provenance_path, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "inspiration-2",
          "https://example.com/inspiration-1",
          "Duplicate source",
          "screenshot",
          "captured",
          "captured",
          "tests/inspiration-2.md",
          "2026-07-24T00:00:00.000Z",
          "2026-07-24T00:00:00.000Z",
        );
    }).toThrow();

    database
      .query(
        `INSERT INTO comparisons (
          id, slug, title, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "comparison-1",
        "comparison-1",
        "Comparison",
        "draft",
        "2026-07-24T00:00:00.000Z",
        "2026-07-24T00:00:00.000Z",
      );
    database
      .query(
        `INSERT INTO aesthetic_directions (
          id, comparison_id, slug, title, position, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "direction-1",
        "comparison-1",
        "quiet",
        "Quiet",
        0,
        "2026-07-24T00:00:00.000Z",
      );

    expect(() =>
      database
        .query(
          `INSERT INTO aesthetic_directions (
            id, comparison_id, slug, title, position, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "direction-2",
          "comparison-1",
          "loud",
          "Loud",
          0,
          "2026-07-24T00:00:00.000Z",
        ),
    ).toThrow();
    database.close();
  });

  test("creates strict Studio tables and enforces their core invariants", () => {
    const database = migratedDatabase();
    const studioTables = [
      "site_projects",
      "project_baselines",
      "exploration_rounds",
      "exploration_round_lineage",
      "direction_selections",
      "agent_sessions",
      "agent_messages",
      "agent_runs",
      "tweak_snapshots",
    ];
    const tableDefinitions = database
      .query<{ name: string; sql: string }, []>(
        `SELECT name, sql
         FROM sqlite_schema
         WHERE type = 'table' AND name LIKE '%'
         ORDER BY name`,
      )
      .all();
    const definitionsByName = new Map(
      tableDefinitions.map(({ name, sql }) => [name, sql]),
    );
    for (const table of studioTables) {
      expect(definitionsByName.get(table)).toContain("STRICT");
    }

    const insertProject = (
      id: string,
      canonicalSourcePath: string,
      runtimePath: string,
      idempotencyKey: string,
    ) =>
      database
        .query(
          `INSERT INTO site_projects (
            id, slug, title, canonical_source_path, runtime_path,
            idempotency_key, request_fingerprint, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          id,
          id,
          canonicalSourcePath,
          runtimePath,
          idempotencyKey,
          `fingerprint-${id}`,
          "2026-07-24T00:00:00.000Z",
          "2026-07-24T00:00:00.000Z",
        );
    insertProject(
      "project-1",
      "/source/one",
      "projects/project-1",
      "request-1",
    );
    insertProject(
      "project-2",
      "/source/two",
      "projects/project-2",
      "request-2",
    );

    expect(() =>
      insertProject(
        "project-3",
        "/source/three",
        "projects/project-3",
        "request-1",
      ),
    ).toThrow();
    database
      .query(
        `INSERT INTO agent_sessions (
          id, project_id, idempotency_key, request_fingerprint, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "session-1",
        "project-1",
        "session-request-1",
        "session-fingerprint-1",
        "2026-07-24T00:00:00.000Z",
        "2026-07-24T00:00:00.000Z",
      );
    database
      .query(
        `INSERT INTO agent_sessions (
          id, project_id, idempotency_key, request_fingerprint, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "session-2",
        "project-1",
        "session-request-2",
        "session-fingerprint-2",
        "2026-07-24T00:00:00.000Z",
        "2026-07-24T00:00:00.000Z",
      );
    database
      .query(
        `INSERT INTO agent_runs (
          id, project_id, session_id, sequence, idempotency_key,
          request_fingerprint, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "run-1",
        "project-1",
        "session-1",
        1,
        "run-request-1",
        "run-fingerprint-1",
        "2026-07-24T00:00:00.000Z",
        "2026-07-24T00:00:00.000Z",
      );
    expect(() =>
      database
        .query(
          `INSERT INTO agent_messages (
            id, project_id, session_id, run_id, sequence, role, content, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "message-cross-session",
          "project-1",
          "session-2",
          "run-1",
          1,
          "user",
          "cross-session",
          "2026-07-24T00:00:00.000Z",
        ),
    ).toThrow();
    expect(() =>
      database
        .query("UPDATE site_projects SET status = 'unknown' WHERE id = ?")
        .run("project-1"),
    ).toThrow();

    database
      .query(
        `INSERT INTO exploration_rounds (
          id, project_id, sequence, stage, idempotency_key, request_fingerprint,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "round-1",
        "project-1",
        1,
        "wide-net",
        "round-request-1",
        "round-fingerprint-1",
        "2026-07-24T00:00:00.000Z",
        "2026-07-24T00:00:00.000Z",
      );
    expect(() =>
      database
        .query(
          `INSERT INTO exploration_round_lineage (
            project_id, ancestor_round_id, descendant_round_id, depth,
            created_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run("project-1", "round-1", "round-1", 1, "2026-07-24T00:00:00.000Z"),
    ).toThrow();
    database
      .query(
        `INSERT INTO exploration_round_lineage (
          project_id, ancestor_round_id, descendant_round_id, depth, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("project-1", "round-1", "round-1", 0, "2026-07-24T00:00:00.000Z");
    expect(() =>
      database
        .query(
          `INSERT INTO agent_sessions (
            id, project_id, round_id, idempotency_key, request_fingerprint,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "session-cross-project",
          "project-2",
          "round-1",
          "session-request",
          "session-fingerprint",
          "2026-07-24T00:00:00.000Z",
          "2026-07-24T00:00:00.000Z",
        ),
    ).toThrow();
    expect(() =>
      database
        .query(
          `INSERT INTO project_baselines (
            id, project_id, revision, source_path, snapshot_path, content_hash,
            file_count, byte_count, idempotency_key, request_fingerprint,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "baseline-bad-hash",
          "project-1",
          1,
          "/source/one",
          "projects/project-1/baselines/1",
          "ABC",
          0,
          0,
          "baseline-request",
          "baseline-fingerprint",
          "2026-07-24T00:00:00.000Z",
        ),
    ).toThrow();
    expect(() =>
      database
        .query(
          `INSERT INTO direction_selections (
            id, project_id, round_id, direction_key, title, position, payload,
            idempotency_key, request_fingerprint, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "selection-bad-json",
          "project-1",
          "round-1",
          "quiet",
          "Quiet",
          0,
          "[]",
          "selection-request",
          "selection-fingerprint",
          "2026-07-24T00:00:00.000Z",
        ),
    ).toThrow();
    database.close();
  });

  test("fails with a stable migration error", () => {
    const database = new Database(":memory:");

    expect(() =>
      migrateDatabase(database, "/definitely/missing/migrations"),
    ).toThrow(DatabaseMigrationError);

    try {
      migrateDatabase(database, "/definitely/missing/migrations");
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseMigrationError);
      expect((error as DatabaseMigrationError).code).toBe(
        DATABASE_MIGRATION_ERROR,
      );
      expect((error as Error).message).toBe(
        `${DATABASE_MIGRATION_ERROR}: discovery`,
      );
    }
    database.close();
  });

  test("rejects applied migrations whose source file is missing", () => {
    const database = new Database(":memory:", { strict: true });
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (99, '0099_removed.sql', 'missing', '2026-07-24T00:00:00.000Z');
    `);

    try {
      migrateDatabase(database);
      throw new Error("expected migration failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseMigrationError);
      expect((error as DatabaseMigrationError).code).toBe(
        DATABASE_MIGRATION_ERROR,
      );
      expect((error as Error).message).toBe(
        `${DATABASE_MIGRATION_ERROR}: 0099_removed.sql`,
      );
    }
    database.close();
  });

  test("allows matching concurrent migration attempts to converge", async () => {
    mkdirSync(TEST_TEMP_ROOT, { recursive: true });
    const fixtureRoot = mkdtempSync(
      join(TEST_TEMP_ROOT, "database-concurrency-"),
    );
    const migrationsDirectory = join(fixtureRoot, "migrations");
    mkdirSync(migrationsDirectory);
    writeFileSync(
      join(migrationsDirectory, "0001_concurrent.sql"),
      `CREATE TABLE concurrency_probe (id INTEGER PRIMARY KEY) STRICT;
       WITH RECURSIVE values_to_insert(id) AS (
         VALUES(1)
         UNION ALL
         SELECT id + 1 FROM values_to_insert WHERE id < 50000
       )
       INSERT INTO concurrency_probe (id) SELECT id FROM values_to_insert;`,
      "utf8",
    );
    const databasePath = join(fixtureRoot, "concurrent.sqlite");
    const workerScript = `
      import { openDatabase } from "./src/server/database.ts";
      const database = openDatabase(
        process.env.TEST_DATABASE_PATH,
        process.env.TEST_MIGRATIONS_DIRECTORY,
      );
      database.close();
    `;
    const environment = {
      ...process.env,
      TEST_DATABASE_PATH: databasePath,
      TEST_MIGRATIONS_DIRECTORY: migrationsDirectory,
    };
    const workers = Array.from({ length: 4 }, () =>
      Bun.spawn([process.execPath, "-e", workerScript], {
        cwd: REPO_ROOT,
        env: environment,
        stderr: "pipe",
        stdout: "pipe",
      }),
    );
    const exitCodes = await Promise.all(workers.map((worker) => worker.exited));
    const errors = await Promise.all(
      workers.map((worker) => new Response(worker.stderr).text()),
    );

    expect(errors).toEqual(["", "", "", ""]);
    expect(exitCodes).toEqual([0, 0, 0, 0]);
    const database = new Database(databasePath, { strict: true });
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM schema_migrations",
        )
        .get()?.count,
    ).toBe(1);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM concurrency_probe",
        )
        .get()?.count,
    ).toBe(50000);
    database.close();
  });
});
