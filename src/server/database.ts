import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_NAME = /^(?<version>\d+)_[a-z0-9_-]+\.sql$/;
const DEFAULT_MIGRATIONS_DIRECTORY = resolve(
  import.meta.dir,
  "../../migrations",
);

export const DATABASE_MIGRATION_ERROR = "DATABASE_MIGRATION_FAILED";

export class DatabaseMigrationError extends Error {
  readonly code = DATABASE_MIGRATION_ERROR;

  constructor(
    readonly migration: string,
    options?: ErrorOptions,
  ) {
    super(`${DATABASE_MIGRATION_ERROR}: ${migration}`, options);
    this.name = "DatabaseMigrationError";
  }
}

interface Migration {
  readonly checksum: string;
  readonly name: string;
  readonly version: number;
  readonly sql: string;
}

function readMigrations(directory: string): Migration[] {
  const migrations = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = MIGRATION_NAME.exec(entry.name);
      if (!match?.groups?.version) {
        return null;
      }

      const sql = readFileSync(resolve(directory, entry.name), "utf8");
      return {
        checksum: createHash("sha256").update(sql).digest("hex"),
        name: entry.name,
        version: Number.parseInt(match.groups.version, 10),
        sql,
      };
    })
    .filter((migration): migration is Migration => migration !== null)
    .sort(
      (left, right) =>
        left.version - right.version || left.name.localeCompare(right.name),
    );

  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1]?.version === migrations[index]?.version) {
      throw new DatabaseMigrationError(migrations[index]?.name ?? "unknown", {
        cause: new Error("Duplicate migration version"),
      });
    }
  }

  return migrations;
}

export function migrateDatabase(
  database: Database,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
): void {
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  let migrations: Migration[];
  try {
    migrations = readMigrations(migrationsDirectory);
  } catch (error) {
    if (error instanceof DatabaseMigrationError) {
      throw error;
    }
    throw new DatabaseMigrationError("discovery", { cause: error });
  }

  const applyMigration = database.transaction((migration: Migration) => {
    const applied = database
      .query<{ checksum: string; name: string }, [number]>(
        "SELECT name, checksum FROM schema_migrations WHERE version = ?",
      )
      .get(migration.version);
    if (applied) {
      if (
        applied.name !== migration.name ||
        applied.checksum !== migration.checksum
      ) {
        throw new DatabaseMigrationError(migration.name, {
          cause: new Error("Applied migration does not match its source"),
        });
      }
      return;
    }

    const newestApplied = database
      .query<{ version: number }, []>(
        "SELECT MAX(version) AS version FROM schema_migrations",
      )
      .get()?.version;
    if (
      newestApplied !== null &&
      newestApplied !== undefined &&
      migration.version < newestApplied
    ) {
      throw new DatabaseMigrationError(migration.name, {
        cause: new Error("Cannot apply an older migration after a newer one"),
      });
    }

    database.exec(migration.sql);
    database
      .query(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at)
         VALUES ($version, $name, $checksum, $appliedAt)`,
      )
      .run({
        checksum: migration.checksum,
        version: migration.version,
        name: migration.name,
        appliedAt: new Date().toISOString(),
      });
  });

  const appliedMigrations = database
    .query<{ checksum: string; name: string; version: number }, []>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    )
    .all();
  const migrationsByVersion = new Map(
    migrations.map((migration) => [migration.version, migration] as const),
  );
  for (const applied of appliedMigrations) {
    const source = migrationsByVersion.get(applied.version);
    if (
      !source ||
      source.name !== applied.name ||
      source.checksum !== applied.checksum
    ) {
      throw new DatabaseMigrationError(applied.name, {
        cause: new Error(
          source
            ? "Applied migration does not match its source"
            : "Applied migration source is missing",
        ),
      });
    }
  }

  for (const migration of migrations) {
    try {
      applyMigration.immediate(migration);
    } catch (error) {
      if (error instanceof DatabaseMigrationError) {
        throw error;
      }
      throw new DatabaseMigrationError(migration.name, { cause: error });
    }
  }
}

export function openDatabase(
  path: string,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
): Database {
  const database = new Database(path, { create: true, strict: true });

  try {
    migrateDatabase(database, migrationsDirectory);
    return database;
  } catch (error) {
    database.close(false);
    throw error;
  }
}
