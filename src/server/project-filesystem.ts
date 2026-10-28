import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const absolutePath = z
  .string()
  .trim()
  .min(1)
  .refine(isAbsolute, "must be an absolute path");
const configSchema = z
  .object({
    allowedSourceRoots: z.array(absolutePath).min(1),
    runtimeRoot: absolutePath,
  })
  .strict();

export type ProjectErrorCode =
  | "PROJECT_CONFLICT"
  | "PROJECT_DATA_INVALID"
  | "PROJECT_INVALID_INPUT"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_RUNTIME_PATH_INVALID"
  | "PROJECT_SNAPSHOT_IO_ERROR"
  | "PROJECT_SOURCE_NOT_ALLOWED"
  | "PROJECT_SOURCE_NOT_DIRECTORY"
  | "PROJECT_SOURCE_NOT_FOUND"
  | "PROJECT_SOURCE_SYMLINK";

export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectError";
  }
}

export interface ProjectStorageConfig {
  allowedSourceRoots: readonly string[];
  runtimeRoot: string;
}

export type CanonicalProjectStorageConfig = {
  allowedSourceRoots: string[];
  runtimeRoot: string;
};

export type SnapshotResult = {
  byteCount: number;
  contentHash: string;
  fileCount: number;
};

const SNAPSHOT_IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "_archive",
]);

function invalidConfig(cause: z.ZodError): ProjectError {
  return new ProjectError("PROJECT_INVALID_INPUT", "Project input is invalid", {
    cause,
  });
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function filesystemErrorCode(error: unknown): string | null {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

/** Reject a destination that passes through a symlinked existing component. */
export function assertNoSymlinkAncestor(path: string, stopAt: string): void {
  let current = path;
  while (isContained(stopAt, current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new ProjectError(
          "PROJECT_RUNTIME_PATH_INVALID",
          "Runtime storage cannot pass through a symbolic link",
        );
      }
    } catch (error) {
      if (error instanceof ProjectError) throw error;
      if (filesystemErrorCode(error) !== "ENOENT") {
        throw new ProjectError(
          "PROJECT_RUNTIME_PATH_INVALID",
          "Runtime storage could not be validated",
          { cause: error },
        );
      }
    }
    if (current === stopAt) return;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  throw new ProjectError(
    "PROJECT_RUNTIME_PATH_INVALID",
    "Runtime storage escapes its configured root",
  );
}

export function ownedPath(root: string, relativePath: string): string {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new ProjectError(
      "PROJECT_RUNTIME_PATH_INVALID",
      "Stored runtime path is invalid",
    );
  }
  const candidate = resolve(root, relativePath);
  if (!isContained(root, candidate)) {
    throw new ProjectError(
      "PROJECT_RUNTIME_PATH_INVALID",
      "Runtime path escapes its configured root",
    );
  }
  return candidate;
}

export function requireOwnedDirectory(
  root: string,
  relativePath: string,
): string {
  const candidate = ownedPath(root, relativePath);
  assertNoSymlinkAncestor(candidate, root);
  try {
    if (
      !statSync(candidate).isDirectory() ||
      realpathSync(candidate) !== candidate
    ) {
      throw new ProjectError(
        "PROJECT_RUNTIME_PATH_INVALID",
        "Runtime storage directory is invalid",
      );
    }
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    throw new ProjectError(
      "PROJECT_RUNTIME_PATH_INVALID",
      "Runtime storage directory is missing or invalid",
      { cause: error },
    );
  }
  return candidate;
}

export function canonicalProjectStorageConfig(
  input: ProjectStorageConfig,
): CanonicalProjectStorageConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw invalidConfig(parsed.error);
  try {
    const allowedSourceRoots = parsed.data.allowedSourceRoots.map((root) =>
      realpathSync(root),
    );
    const configuredRuntimeRoot = resolve(parsed.data.runtimeRoot);

    let existingAncestor = configuredRuntimeRoot;
    while (!existsSync(existingAncestor)) {
      const parent = resolve(existingAncestor, "..");
      if (parent === existingAncestor) break;
      existingAncestor = parent;
    }
    const canonicalAncestor = realpathSync(existingAncestor);
    const canonicalRuntimeRoot = resolve(
      canonicalAncestor,
      relative(existingAncestor, configuredRuntimeRoot),
    );
    if (
      canonicalRuntimeRoot !== configuredRuntimeRoot ||
      allowedSourceRoots.some(
        (root) =>
          isContained(root, canonicalRuntimeRoot) ||
          isContained(canonicalRuntimeRoot, root),
      )
    ) {
      throw new ProjectError(
        "PROJECT_RUNTIME_PATH_INVALID",
        "Runtime storage must not overlap an allowed source root",
      );
    }

    mkdirSync(configuredRuntimeRoot, { recursive: true });
    const runtimeRoot = realpathSync(configuredRuntimeRoot);
    if (runtimeRoot !== configuredRuntimeRoot) {
      throw new ProjectError(
        "PROJECT_RUNTIME_PATH_INVALID",
        "Runtime storage must resolve to its configured path",
      );
    }
    assertNoSymlinkAncestor(runtimeRoot, runtimeRoot);
    return { allowedSourceRoots, runtimeRoot };
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    throw new ProjectError(
      "PROJECT_RUNTIME_PATH_INVALID",
      "Project storage configuration is invalid",
      { cause: error },
    );
  }
}

export function canonicalProjectSource(
  sourcePath: string,
  config: CanonicalProjectStorageConfig,
): string {
  try {
    const sourceStat = lstatSync(sourcePath);
    if (sourceStat.isSymbolicLink()) {
      throw new ProjectError(
        "PROJECT_SOURCE_SYMLINK",
        "Project source must not be a symbolic link",
      );
    }
    const canonical = realpathSync(sourcePath);
    if (!statSync(canonical).isDirectory()) {
      throw new ProjectError(
        "PROJECT_SOURCE_NOT_DIRECTORY",
        "Project source must be a directory",
      );
    }
    if (
      !config.allowedSourceRoots.some((root) => isContained(root, canonical))
    ) {
      throw new ProjectError(
        "PROJECT_SOURCE_NOT_ALLOWED",
        "Project source is outside the configured roots",
      );
    }
    if (isContained(config.runtimeRoot, canonical)) {
      throw new ProjectError(
        "PROJECT_SOURCE_NOT_ALLOWED",
        "Project source must not be inside runtime storage",
      );
    }
    return canonical;
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    const code = filesystemErrorCode(error);
    throw new ProjectError(
      code === "ENOENT"
        ? "PROJECT_SOURCE_NOT_FOUND"
        : "PROJECT_SOURCE_NOT_ALLOWED",
      code === "ENOENT"
        ? "Project source does not exist"
        : "Project source could not be validated",
      { cause: error },
    );
  }
}

export function archiveOwnedPath(path: string, root: string): string | null {
  if (!existsSync(path)) return null;
  if (!isContained(root, path)) {
    throw new ProjectError(
      "PROJECT_RUNTIME_PATH_INVALID",
      "Only workbench-owned runtime paths may be archived",
    );
  }
  assertNoSymlinkAncestor(path, root);
  if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) {
    throw new ProjectError(
      "PROJECT_RUNTIME_PATH_INVALID",
      "Only workbench-owned runtime paths may be archived",
    );
  }
  const archiveRoot = ownedPath(root, "_archive");
  assertNoSymlinkAncestor(archiveRoot, root);
  mkdirSync(archiveRoot, { recursive: true });
  assertNoSymlinkAncestor(archiveRoot, root);
  requireOwnedDirectory(root, "_archive");
  const destination = ownedPath(
    archiveRoot,
    `${path.split(sep).at(-1) ?? "project"}-${Date.now()}-${randomUUID()}`,
  );
  assertNoSymlinkAncestor(destination, archiveRoot);
  renameSync(path, destination);
  assertNoSymlinkAncestor(destination, archiveRoot);
  return destination;
}

export function copyProjectSnapshot(
  sourceRoot: string,
  destinationRoot: string,
): SnapshotResult {
  const hash = createHash("sha256");
  let fileCount = 0;
  let byteCount = 0;

  const visit = (sourceDirectory: string, relativeDirectory: string): void => {
    const destinationDirectory = ownedPath(
      destinationRoot,
      relativeDirectory || ".",
    );
    assertNoSymlinkAncestor(destinationDirectory, destinationRoot);
    mkdirSync(destinationDirectory, { recursive: true });
    assertNoSymlinkAncestor(destinationDirectory, destinationRoot);
    if (realpathSync(destinationDirectory) !== destinationDirectory) {
      throw new ProjectError(
        "PROJECT_RUNTIME_PATH_INVALID",
        "Snapshot destination is not workbench-owned",
      );
    }
    for (const entry of readdirSync(sourceDirectory, {
      withFileTypes: true,
    }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && SNAPSHOT_IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const source = resolve(sourceDirectory, entry.name);
      const relativePath = relative(sourceRoot, source);
      const sourceStat = lstatSync(source);
      if (sourceStat.isSymbolicLink()) {
        throw new ProjectError(
          "PROJECT_SOURCE_SYMLINK",
          `Project source contains a symbolic link at '${relativePath}'`,
        );
      }
      const canonical = realpathSync(source);
      if (!isContained(sourceRoot, canonical)) {
        throw new ProjectError(
          "PROJECT_SOURCE_NOT_ALLOWED",
          "Project source entry escapes its root",
        );
      }
      if (sourceStat.isDirectory()) {
        visit(canonical, relativePath);
        continue;
      }
      if (!sourceStat.isFile()) {
        throw new ProjectError(
          "PROJECT_SOURCE_NOT_ALLOWED",
          `Project source contains a non-regular entry at '${relativePath}'`,
        );
      }

      let descriptor: number | null = null;
      try {
        descriptor = openSync(
          source,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        const openedStat = fstatSync(descriptor);
        if (
          !openedStat.isFile() ||
          openedStat.dev !== sourceStat.dev ||
          openedStat.ino !== sourceStat.ino
        ) {
          throw new ProjectError(
            "PROJECT_SOURCE_NOT_ALLOWED",
            "Project source entry changed while being copied",
          );
        }
        const bytes = readFileSync(descriptor);
        const destination = ownedPath(destinationRoot, relativePath);
        assertNoSymlinkAncestor(destination, destinationRoot);
        mkdirSync(resolve(destination, ".."), { recursive: true });
        assertNoSymlinkAncestor(destination, destinationRoot);
        writeFileSync(destination, bytes, { flag: "wx" });
        const relativeBytes = Buffer.from(relativePath, "utf8");
        hash.update(String(relativeBytes.byteLength));
        hash.update(":");
        hash.update(relativeBytes);
        hash.update(":");
        hash.update(String(bytes.byteLength));
        hash.update(":");
        hash.update(bytes);
        fileCount += 1;
        byteCount += bytes.byteLength;
      } finally {
        if (descriptor !== null) closeSync(descriptor);
      }
    }
  };

  visit(sourceRoot, "");
  return { byteCount, contentHash: hash.digest("hex"), fileCount };
}
