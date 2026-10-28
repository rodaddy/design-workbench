import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  archiveOwnedPath,
  assertNoSymlinkAncestor,
  canonicalProjectSource,
  canonicalProjectStorageConfig,
  copyProjectSnapshot,
  ownedPath,
  ProjectError,
  requireOwnedDirectory,
  type CanonicalProjectStorageConfig,
  type ProjectStorageConfig,
} from "./project-filesystem";

export {
  ProjectError,
  type ProjectErrorCode,
  type ProjectStorageConfig,
} from "./project-filesystem";

const identifier = z.string().trim().min(1).max(200);
const slug = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const absolutePath = z
  .string()
  .trim()
  .min(1)
  .refine(isAbsolute, "must be an absolute path");
const createProjectSchema = z
  .object({
    slug,
    title: z.string().trim().min(1).max(200),
    sourcePath: absolutePath,
    idempotencyKey: identifier,
  })
  .strict();
const updateProjectSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    status: z.enum(["active", "archived"]).optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict()
  .refine(
    (value) => value.title !== undefined || value.status !== undefined,
    "at least one update field is required",
  );
const deleteProjectSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();
const baselineSchema = z.object({ idempotencyKey: identifier }).strict();

export interface ProjectBaseline {
  id: string;
  projectId: string;
  revision: number;
  sourcePath: string;
  snapshotPath: string;
  contentHash: string;
  fileCount: number;
  byteCount: number;
  idempotencyKey: string;
  createdAt: string;
}

export interface StudioProject {
  id: string;
  slug: string;
  title: string;
  canonicalSourcePath: string;
  runtimePath: string;
  status: "active" | "archived";
  version: number;
  createdAt: string;
  updatedAt: string;
  baselines: ProjectBaseline[];
}

type ProjectRow = {
  id: string;
  slug: string;
  title: string;
  canonical_source_path: string;
  runtime_path: string;
  status: string;
  idempotency_key: string;
  request_fingerprint: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type BaselineRow = {
  id: string;
  project_id: string;
  revision: number;
  source_path: string;
  snapshot_path: string;
  content_hash: string;
  file_count: number;
  byte_count: number;
  idempotency_key: string;
  request_fingerprint: string;
  created_at: string;
};

const storedProjectSchema = z.object({
  id: z.string().uuid(),
  slug,
  title: z.string().trim().min(1).max(200),
  canonical_source_path: absolutePath.refine(
    (value) => resolve(value) === value,
    "must be normalized",
  ),
  runtime_path: z.string(),
  status: z.enum(["active", "archived"]),
  idempotency_key: identifier,
  request_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.number().int().positive(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});
const storedBaselineSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  revision: z.number().int().positive(),
  source_path: absolutePath.refine(
    (value) => resolve(value) === value,
    "must be normalized",
  ),
  snapshot_path: z.string(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  file_count: z.number().int().nonnegative(),
  byte_count: z.number().int().nonnegative(),
  idempotency_key: identifier,
  request_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.string().min(1),
});

function invalidInput(cause: z.ZodError): ProjectError {
  return new ProjectError("PROJECT_INVALID_INPUT", "Project input is invalid", {
    cause,
  });
}

function dataInvalid(message: string, cause?: unknown): ProjectError {
  return new ProjectError("PROJECT_DATA_INVALID", message, { cause });
}

function baselineFromRow(row: BaselineRow): ProjectBaseline {
  return {
    id: row.id,
    projectId: row.project_id,
    revision: row.revision,
    sourcePath: row.source_path,
    snapshotPath: row.snapshot_path,
    contentHash: row.content_hash,
    fileCount: row.file_count,
    byteCount: row.byte_count,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

export class StudioProjectStore {
  private readonly config: CanonicalProjectStorageConfig;

  constructor(
    private readonly database: Database,
    config: ProjectStorageConfig,
  ) {
    this.config = canonicalProjectStorageConfig(config);
  }

  private projectRows(identifierInput: unknown): ProjectRow[] {
    const parsed = identifier.safeParse(identifierInput);
    if (!parsed.success) throw invalidInput(parsed.error);
    const rows = this.database
      .query<ProjectRow, [string, string]>(
        "SELECT * FROM site_projects WHERE id = ? OR slug = ? ORDER BY id LIMIT 2",
      )
      .all(parsed.data, parsed.data);
    if (rows.length > 1) {
      throw new ProjectError(
        "PROJECT_CONFLICT",
        "Project identifier is ambiguous",
      );
    }
    return rows;
  }

  private validateBaseline(
    row: BaselineRow,
    project: ProjectRow,
  ): ProjectBaseline {
    const parsed = storedBaselineSchema.safeParse(row);
    if (!parsed.success) {
      throw dataInvalid("Stored project baseline is invalid", parsed.error);
    }
    const baseline = parsed.data;
    if (
      baseline.project_id !== project.id ||
      baseline.source_path !== project.canonical_source_path ||
      baseline.snapshot_path !==
        `${project.runtime_path}/baselines/${baseline.revision}`
    ) {
      throw dataInvalid("Stored project baseline does not match its project");
    }
    return baselineFromRow(baseline);
  }

  private projectFromRow(row: ProjectRow): StudioProject {
    const parsed = storedProjectSchema.safeParse(row);
    if (!parsed.success) {
      throw dataInvalid("Stored project is invalid", parsed.error);
    }
    const project = parsed.data;
    if (project.runtime_path !== `projects/${project.id}`) {
      throw dataInvalid("Stored project runtime path is invalid");
    }
    const baselines = this.database
      .query<BaselineRow, [string]>(
        "SELECT * FROM project_baselines WHERE project_id = ? ORDER BY revision, id",
      )
      .all(project.id)
      .map((baseline) => this.validateBaseline(baseline, project));
    return {
      id: project.id,
      slug: project.slug,
      title: project.title,
      canonicalSourcePath: project.canonical_source_path,
      runtimePath: project.runtime_path,
      status: project.status,
      version: project.version,
      createdAt: project.created_at,
      updatedAt: project.updated_at,
      baselines,
    };
  }

  private persistedProject(row: ProjectRow): StudioProject {
    const project = this.projectFromRow(row);
    requireOwnedDirectory(this.config.runtimeRoot, project.runtimePath);
    if (!project.baselines.some((baseline) => baseline.revision === 1)) {
      throw dataInvalid("Stored project has no initial baseline");
    }
    for (const baseline of project.baselines) {
      requireOwnedDirectory(this.config.runtimeRoot, baseline.snapshotPath);
    }
    return project;
  }

  private persistedBaseline(
    row: BaselineRow,
    project: StudioProject,
  ): ProjectBaseline {
    const projectRow = this.database
      .query<ProjectRow, [string]>("SELECT * FROM site_projects WHERE id = ?")
      .get(project.id);
    if (!projectRow)
      throw new ProjectError("PROJECT_NOT_FOUND", "Project does not exist");
    const baseline = this.validateBaseline(row, projectRow);
    requireOwnedDirectory(this.config.runtimeRoot, baseline.snapshotPath);
    return baseline;
  }

  listProjects(): StudioProject[] {
    return this.database
      .query<ProjectRow, []>(
        "SELECT * FROM site_projects ORDER BY created_at DESC, id",
      )
      .all()
      .map((row) => this.projectFromRow(row));
  }

  getProject(identifierInput: unknown): StudioProject {
    const row = this.projectRows(identifierInput)[0];
    if (!row) {
      throw new ProjectError("PROJECT_NOT_FOUND", "Project does not exist");
    }
    return this.projectFromRow(row);
  }

  createProject(input: unknown): StudioProject {
    const parsed = createProjectSchema.safeParse(input);
    if (!parsed.success) throw invalidInput(parsed.error);
    const requestedSourcePath = resolve(parsed.data.sourcePath);
    const requestFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          slug: parsed.data.slug,
          sourcePath: requestedSourcePath,
          title: parsed.data.title,
        }),
      )
      .digest("hex");
    const existing = this.database
      .query<ProjectRow, [string]>(
        "SELECT * FROM site_projects WHERE idempotency_key = ?",
      )
      .get(parsed.data.idempotencyKey);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw new ProjectError(
          "PROJECT_CONFLICT",
          "Project idempotency key was used for different input",
        );
      }
      return this.persistedProject(existing);
    }

    const sourcePath = canonicalProjectSource(
      parsed.data.sourcePath,
      this.config,
    );
    const projectId = randomUUID();
    const baselineId = randomUUID();
    const runtimePath = `projects/${projectId}`;
    const snapshotPath = `${runtimePath}/baselines/1`;
    const finalRuntime = ownedPath(this.config.runtimeRoot, runtimePath);
    const staging = ownedPath(
      this.config.runtimeRoot,
      `_staging-${projectId}-${randomUUID()}`,
    );
    let staged = false;
    let finalized = false;
    try {
      const namespaceCollision = this.database
        .query<{ id: string }, [string, string, string, string]>(
          `SELECT id FROM site_projects
           WHERE id = ? OR slug = ? OR id = ? OR slug = ? LIMIT 1`,
        )
        .get(projectId, parsed.data.slug, parsed.data.slug, projectId);
      if (namespaceCollision) {
        throw new ProjectError(
          "PROJECT_CONFLICT",
          "Project id and slug namespaces must not overlap",
        );
      }
      assertNoSymlinkAncestor(staging, this.config.runtimeRoot);
      mkdirSync(staging, { recursive: false });
      assertNoSymlinkAncestor(staging, this.config.runtimeRoot);
      if (realpathSync(staging) !== staging) {
        throw new ProjectError(
          "PROJECT_RUNTIME_PATH_INVALID",
          "Project staging directory is invalid",
        );
      }
      staged = true;
      const stagedSnapshot = ownedPath(staging, "baselines/1");
      const snapshot = copyProjectSnapshot(sourcePath, stagedSnapshot);
      assertNoSymlinkAncestor(finalRuntime, this.config.runtimeRoot);
      mkdirSync(resolve(finalRuntime, ".."), { recursive: true });
      assertNoSymlinkAncestor(finalRuntime, this.config.runtimeRoot);
      if (existsSync(finalRuntime)) {
        throw new ProjectError(
          "PROJECT_CONFLICT",
          "Project runtime directory already exists",
        );
      }
      renameSync(staging, finalRuntime);
      staged = false;
      finalized = true;
      requireOwnedDirectory(this.config.runtimeRoot, runtimePath);
      const now = new Date().toISOString();
      const persist = this.database.transaction(() => {
        this.database
          .query(
            `INSERT INTO site_projects (
              id, slug, title, canonical_source_path, runtime_path, status,
              idempotency_key, request_fingerprint, version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            projectId,
            parsed.data.slug,
            parsed.data.title,
            sourcePath,
            runtimePath,
            "active",
            parsed.data.idempotencyKey,
            requestFingerprint,
            1,
            now,
            now,
          );
        this.database
          .query(
            `INSERT INTO project_baselines (
              id, project_id, revision, source_path, snapshot_path, content_hash,
              file_count, byte_count, idempotency_key, request_fingerprint,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            baselineId,
            projectId,
            1,
            sourcePath,
            snapshotPath,
            snapshot.contentHash,
            snapshot.fileCount,
            snapshot.byteCount,
            parsed.data.idempotencyKey,
            requestFingerprint,
            now,
          );
      });
      persist.immediate();
      finalized = false;
      return this.getProject(projectId);
    } catch (error) {
      try {
        if (staged) archiveOwnedPath(staging, this.config.runtimeRoot);
        if (finalized) archiveOwnedPath(finalRuntime, this.config.runtimeRoot);
      } catch {
        // Preserve the original failure; orphaned runtime state is fail-closed.
      }
      if (error instanceof ProjectError) throw error;
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        const winner = this.database
          .query<ProjectRow, [string]>(
            "SELECT * FROM site_projects WHERE idempotency_key = ?",
          )
          .get(parsed.data.idempotencyKey);
        if (winner && winner.request_fingerprint === requestFingerprint) {
          return this.persistedProject(winner);
        }
        throw new ProjectError("PROJECT_CONFLICT", "Project already exists", {
          cause: error,
        });
      }
      throw new ProjectError(
        "PROJECT_SNAPSHOT_IO_ERROR",
        "Project snapshot could not be created",
        { cause: error },
      );
    }
  }

  createBaseline(projectIdentifier: unknown, input: unknown): ProjectBaseline {
    const parsed = baselineSchema.safeParse(input);
    if (!parsed.success) throw invalidInput(parsed.error);
    const project = this.getProject(projectIdentifier);
    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify({ projectId: project.id }))
      .digest("hex");
    const existing = this.database
      .query<BaselineRow, [string, string]>(
        `SELECT * FROM project_baselines
         WHERE project_id = ? AND idempotency_key = ?`,
      )
      .get(project.id, parsed.data.idempotencyKey);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw new ProjectError(
          "PROJECT_CONFLICT",
          "Baseline idempotency key was used for different input",
        );
      }
      return this.persistedBaseline(existing, project);
    }

    const sourcePath = canonicalProjectSource(
      project.canonicalSourcePath,
      this.config,
    );
    const baselineId = randomUUID();
    const staging = ownedPath(
      this.config.runtimeRoot,
      `${project.runtimePath}/_staging-${baselineId}`,
    );
    let staged = false;
    let finalized = false;
    let finalSnapshot: string | null = null;
    let finalRevision: number | null = null;
    try {
      assertNoSymlinkAncestor(staging, this.config.runtimeRoot);
      mkdirSync(staging, { recursive: false });
      assertNoSymlinkAncestor(staging, this.config.runtimeRoot);
      if (realpathSync(staging) !== staging) {
        throw new ProjectError(
          "PROJECT_RUNTIME_PATH_INVALID",
          "Baseline staging directory is invalid",
        );
      }
      staged = true;
      const snapshot = copyProjectSnapshot(sourcePath, staging);
      const persist = this.database.transaction(
        ():
          | { kind: "created"; row: BaselineRow }
          | { kind: "winner"; row: BaselineRow } => {
          const winner = this.database
            .query<BaselineRow, [string, string]>(
              `SELECT * FROM project_baselines
             WHERE project_id = ? AND idempotency_key = ?`,
            )
            .get(project.id, parsed.data.idempotencyKey);
          if (winner) {
            if (winner.request_fingerprint !== requestFingerprint) {
              throw new ProjectError(
                "PROJECT_CONFLICT",
                "Baseline idempotency key was used for different input",
              );
            }
            return { kind: "winner", row: winner };
          }

          const revision =
            (this.database
              .query<{ revision: number | null }, [string]>(
                "SELECT MAX(revision) AS revision FROM project_baselines WHERE project_id = ?",
              )
              .get(project.id)?.revision ?? 0) + 1;
          finalRevision = revision;
          const snapshotPath = `${project.runtimePath}/baselines/${revision}`;
          finalSnapshot = ownedPath(this.config.runtimeRoot, snapshotPath);
          assertNoSymlinkAncestor(finalSnapshot, this.config.runtimeRoot);
          if (existsSync(finalSnapshot)) {
            const persistedRevision = this.database
              .query<BaselineRow, [string, number]>(
                "SELECT * FROM project_baselines WHERE project_id = ? AND revision = ?",
              )
              .get(project.id, revision);
            if (persistedRevision) {
              throw new ProjectError(
                "PROJECT_CONFLICT",
                "Baseline snapshot directory already exists",
              );
            }
            archiveOwnedPath(finalSnapshot, this.config.runtimeRoot);
            if (existsSync(finalSnapshot)) {
              throw new ProjectError(
                "PROJECT_CONFLICT",
                "Baseline snapshot directory already exists",
              );
            }
          }

          renameSync(staging, finalSnapshot);
          staged = false;
          finalized = true;
          requireOwnedDirectory(this.config.runtimeRoot, snapshotPath);
          const now = new Date().toISOString();
          this.database
            .query(
              `INSERT INTO project_baselines (
              id, project_id, revision, source_path, snapshot_path, content_hash,
              file_count, byte_count, idempotency_key, request_fingerprint,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              baselineId,
              project.id,
              revision,
              sourcePath,
              snapshotPath,
              snapshot.contentHash,
              snapshot.fileCount,
              snapshot.byteCount,
              parsed.data.idempotencyKey,
              requestFingerprint,
              now,
            );
          const row = this.database
            .query<BaselineRow, [string]>(
              "SELECT * FROM project_baselines WHERE id = ?",
            )
            .get(baselineId);
          if (!row) throw dataInvalid("Persisted baseline was not found");
          return { kind: "created", row };
        },
      );
      const outcome = persist.immediate();
      if (outcome.kind === "winner") {
        archiveOwnedPath(staging, this.config.runtimeRoot);
        staged = false;
      } else {
        finalized = false;
      }
      return this.persistedBaseline(outcome.row, project);
    } catch (error) {
      try {
        if (staged) archiveOwnedPath(staging, this.config.runtimeRoot);
        if (finalized && finalSnapshot && finalRevision !== null) {
          const cleanupPath = finalSnapshot;
          const cleanupRevision = finalRevision;
          const cleanup = this.database.transaction(() => {
            const persisted = this.database
              .query<{ id: string }, [string, number]>(
                `SELECT id FROM project_baselines
                 WHERE project_id = ? AND revision = ?`,
              )
              .get(project.id, cleanupRevision);
            if (!persisted) {
              archiveOwnedPath(cleanupPath, this.config.runtimeRoot);
            }
          });
          cleanup.immediate();
        }
      } catch {
        // Preserve the original failure; orphaned runtime state is fail-closed.
      }
      if (error instanceof ProjectError) throw error;
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        const winner = this.database
          .query<BaselineRow, [string, string]>(
            `SELECT * FROM project_baselines
             WHERE project_id = ? AND idempotency_key = ?`,
          )
          .get(project.id, parsed.data.idempotencyKey);
        if (winner && winner.request_fingerprint === requestFingerprint) {
          return this.persistedBaseline(winner, project);
        }
        throw new ProjectError("PROJECT_CONFLICT", "Baseline already exists", {
          cause: error,
        });
      }
      throw new ProjectError(
        "PROJECT_SNAPSHOT_IO_ERROR",
        "Project baseline could not be created",
        { cause: error },
      );
    }
  }

  updateProject(identifierInput: unknown, input: unknown): StudioProject {
    const parsed = updateProjectSchema.safeParse(input);
    if (!parsed.success) throw invalidInput(parsed.error);
    const project = this.getProject(identifierInput);
    const result = this.database
      .query(
        `UPDATE site_projects
         SET title = ?, status = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        parsed.data.title ?? project.title,
        parsed.data.status ?? project.status,
        new Date().toISOString(),
        project.id,
        parsed.data.expectedVersion,
      );
    if (result.changes !== 1) {
      throw new ProjectError(
        "PROJECT_CONFLICT",
        "Project changed before the update completed",
      );
    }
    return this.getProject(project.id);
  }

  deleteProject(identifierInput: unknown, input: unknown): void {
    const parsed = deleteProjectSchema.safeParse(input);
    if (!parsed.success) throw invalidInput(parsed.error);
    const project = this.getProject(identifierInput);
    if (project.version !== parsed.data.expectedVersion) {
      throw new ProjectError(
        "PROJECT_CONFLICT",
        "Project changed before deletion",
      );
    }
    const runtime = ownedPath(this.config.runtimeRoot, project.runtimePath);
    let archived: string | null = null;
    try {
      archived = archiveOwnedPath(runtime, this.config.runtimeRoot);
      const remove = this.database.transaction(() => {
        const result = this.database
          .query("DELETE FROM site_projects WHERE id = ? AND version = ?")
          .run(project.id, parsed.data.expectedVersion);
        if (result.changes < 1) {
          throw new ProjectError(
            "PROJECT_CONFLICT",
            "Project changed before deletion",
          );
        }
      });
      remove.immediate();
    } catch (error) {
      if (archived && !existsSync(runtime)) {
        assertNoSymlinkAncestor(runtime, this.config.runtimeRoot);
        mkdirSync(resolve(runtime, ".."), { recursive: true });
        assertNoSymlinkAncestor(runtime, this.config.runtimeRoot);
        renameSync(archived, runtime);
        requireOwnedDirectory(this.config.runtimeRoot, project.runtimePath);
      }
      if (error instanceof ProjectError) throw error;
      throw new ProjectError(
        "PROJECT_SNAPSHOT_IO_ERROR",
        "Project could not be deleted",
        { cause: error },
      );
    }
  }
}
