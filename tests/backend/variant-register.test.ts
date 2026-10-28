import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { migrateDatabase } from "../../src/server/database";
import {
  registerVariant,
  VariantRegistrationError,
} from "../../src/server/variants";

const TEMP_ROOT = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/variant-register-tests",
);
const createdDirectories: string[] = [];

function fixture(): {
  database: Database;
  generatedRoot: string;
  artifactPath: string;
} {
  const runRoot = resolve(TEMP_ROOT, crypto.randomUUID());
  const generatedRoot = resolve(runRoot, "generated-variants");
  const artifactPath = resolve(
    generatedRoot,
    "comparison-1",
    "quiet",
    "impeccable",
  );
  mkdirSync(artifactPath, { recursive: true });
  writeFileSync(resolve(artifactPath, "index.html"), "<h1>Quiet</h1>", "utf8");
  createdDirectories.push(runRoot);

  const database = new Database(":memory:", { strict: true });
  migrateDatabase(database);
  const now = "2026-07-24T00:00:00.000Z";
  database
    .query(
      `INSERT INTO comparisons (
        id, slug, title, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("comparison-1", "portfolio", "Portfolio", "draft", now, now);
  database
    .query(
      `INSERT INTO aesthetic_directions (
        id, comparison_id, slug, title, position, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("direction-1", "comparison-1", "quiet", "Quiet", 0, now);
  database
    .query(
      `INSERT INTO aesthetic_directions (
        id, comparison_id, slug, title, position, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("direction-2", "comparison-1", "loud", "Loud", 1, now);
  return { database, generatedRoot, artifactPath };
}

afterEach(() => {
  const archiveRoot = resolve(TEMP_ROOT, "_archive");
  mkdirSync(archiveRoot, { recursive: true });
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (!directory) continue;
    Bun.spawnSync(["mv", directory, resolve(archiveRoot, crypto.randomUUID())]);
  }
});

describe("variant registration", () => {
  test("registers a contained variant and updates it idempotently", () => {
    const { database, generatedRoot, artifactPath } = fixture();
    const first = registerVariant(database, {
      comparison: "portfolio",
      direction: "direction-1",
      engine: "impeccable",
      path: artifactPath,
      generatedRoot,
      viewport: { width: 1440, height: 900 },
      metadata: { generator: "fixture" },
    });
    const second = registerVariant(database, {
      comparison: "comparison-1",
      direction: "quiet",
      engine: "impeccable",
      path: artifactPath,
      generatedRoot,
      metadata: { generator: "updated" },
    });

    expect(second.id).toBe(first.id);
    expect(second.artifactPath).toBe("comparison-1/quiet/impeccable");
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM variants")
        .get()?.count,
    ).toBe(1);
    expect(
      database
        .query<{ metadata: string }, []>(
          "SELECT metadata FROM variants LIMIT 1",
        )
        .get()?.metadata,
    ).toBe('{"generator":"updated"}');
    database.close();
  });

  test("rejects invalid engines before persistence", () => {
    const { database, generatedRoot, artifactPath } = fixture();
    expect(() =>
      registerVariant(database, {
        comparison: "comparison-1",
        direction: "quiet",
        engine: "unknown",
        path: artifactPath,
        generatedRoot,
      }),
    ).toThrow(VariantRegistrationError);
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM variants")
        .get()?.count,
    ).toBe(0);
    database.close();
  });

  test("rejects missing index files and symlink escapes", () => {
    const { database, generatedRoot, artifactPath } = fixture();
    const tastePath = resolve(generatedRoot, "comparison-1", "quiet", "taste");
    mkdirSync(tastePath, { recursive: true });
    expect(() =>
      registerVariant(database, {
        comparison: "comparison-1",
        direction: "quiet",
        engine: "taste",
        path: tastePath,
        generatedRoot,
      }),
    ).toThrow("regular index.html");

    const outside = resolve(generatedRoot, "..", "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(resolve(outside, "index.html"), "outside", "utf8");
    const linkedPath = resolve(
      generatedRoot,
      "comparison-1",
      "quiet",
      "taste-link",
    );
    symlinkSync(outside, linkedPath);
    expect(() =>
      registerVariant(database, {
        comparison: "comparison-1",
        direction: "quiet",
        engine: "taste",
        path: linkedPath,
        generatedRoot,
      }),
    ).toThrow("escapes");
    database.close();
  });

  test("rejects cross-registration to another direction", () => {
    const { database, generatedRoot, artifactPath } = fixture();
    expect(() =>
      registerVariant(database, {
        comparison: "comparison-1",
        direction: "loud",
        engine: "impeccable",
        path: artifactPath,
        generatedRoot,
      }),
    ).toThrow("does not match");
    expect(() =>
      registerVariant(database, {
        comparison: "missing",
        direction: "quiet",
        engine: "impeccable",
        path: artifactPath,
        generatedRoot,
      }),
    ).toThrow("No comparison exists");
    database.close();
  });

  test("rejects an identifier shared by a comparison id and another comparison slug", () => {
    const { database, generatedRoot, artifactPath } = fixture();
    const now = "2026-07-24T00:00:00.000Z";
    database
      .query(
        `INSERT INTO comparisons (
          id, slug, title, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("portfolio", "portfolio-collision", "Collision", "draft", now, now);

    try {
      registerVariant(database, {
        comparison: "portfolio",
        direction: "quiet",
        engine: "impeccable",
        path: artifactPath,
        generatedRoot,
      });
      throw new Error("Expected ambiguous comparison registration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(VariantRegistrationError);
      expect((error as VariantRegistrationError).code).toBe(
        "COMPARISON_CONFLICT",
      );
      expect((error as Error).message).toBe(
        "Comparison identifier 'portfolio' is ambiguous",
      );
    }
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM variants")
        .get()?.count,
    ).toBe(0);
    database.close();
  });

  test("rejects an identifier shared by direction id and slug within the chosen comparison", () => {
    const { database, generatedRoot, artifactPath } = fixture();
    const now = "2026-07-24T00:00:00.000Z";
    database
      .query(
        `INSERT INTO aesthetic_directions (
          id, comparison_id, slug, title, position, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("quiet", "comparison-1", "quiet-collision", "Collision", 2, now);

    try {
      registerVariant(database, {
        comparison: "comparison-1",
        direction: "quiet",
        engine: "impeccable",
        path: artifactPath,
        generatedRoot,
      });
      throw new Error("Expected ambiguous direction registration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(VariantRegistrationError);
      expect((error as VariantRegistrationError).code).toBe(
        "DIRECTION_CONFLICT",
      );
      expect((error as Error).message).toBe(
        "Direction identifier 'quiet' is ambiguous within comparison 'comparison-1'",
      );
    }
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM variants")
        .get()?.count,
    ).toBe(0);
    database.close();
  });

  test("CLI returns stable JSON and a nonzero exit for invalid input", () => {
    const command = Bun.spawnSync({
      cmd: [
        process.execPath,
        "run",
        "scripts/variant-register.ts",
        "--comparison",
        "comparison-1",
        "--direction",
        "quiet",
        "--engine",
        "wrong",
        "--path",
        "generated-variants/comparison-1/quiet/wrong",
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

  test("CLI help states the registration-only operator boundary", () => {
    const command = Bun.spawnSync({
      cmd: [process.execPath, "run", "scripts/variant-register.ts", "--help"],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(command.exitCode).toBe(0);
    expect(command.stdout.toString()).toContain("bun run variant:register");
    expect(command.stdout.toString()).toContain("does not invoke a model");
    expect(command.stderr.toString()).toBe("");
  });

  test("CLI registers a valid artifact against an explicit database", () => {
    const runRoot = resolve(TEMP_ROOT, crypto.randomUUID());
    const databasePath = resolve(runRoot, "workbench.sqlite");
    const generatedRoot = resolve(runRoot, "generated-variants");
    const artifactPath = resolve(
      generatedRoot,
      "comparison-cli",
      "direction-cli",
      "taste",
    );
    mkdirSync(artifactPath, { recursive: true });
    writeFileSync(resolve(artifactPath, "index.html"), "<h1>CLI fixture</h1>");
    createdDirectories.push(runRoot);

    const database = new Database(databasePath, { create: true, strict: true });
    migrateDatabase(database);
    const now = "2026-07-24T00:00:00.000Z";
    database
      .query(
        `INSERT INTO comparisons (
          id, slug, title, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "comparison-cli",
        "comparison-cli-slug",
        "CLI comparison",
        "draft",
        now,
        now,
      );
    database
      .query(
        `INSERT INTO aesthetic_directions (
          id, comparison_id, slug, title, position, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "direction-cli-id",
        "comparison-cli",
        "direction-cli",
        "CLI direction",
        0,
        now,
      );
    database.close();

    const command = Bun.spawnSync({
      cmd: [
        process.execPath,
        "run",
        "scripts/variant-register.ts",
        "--comparison",
        "comparison-cli",
        "--direction",
        "direction-cli",
        "--engine",
        "taste",
        "--path",
        artifactPath,
        "--db",
        databasePath,
        "--generated-root",
        generatedRoot,
      ],
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(command.exitCode).toBe(0);
    expect(JSON.parse(command.stdout.toString())).toMatchObject({
      ok: true,
      variant: {
        comparisonId: "comparison-cli",
        engine: "taste",
        artifactPath: "comparison-cli/direction-cli/taste",
      },
    });
    expect(command.stderr.toString()).toBe("");
  });
});
