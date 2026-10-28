import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { migrateDatabase } from "../../src/server/database";
import { ProjectError, StudioProjectStore } from "../../src/server/projects";

const TEMP_ROOT = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/project-tests",
  `${process.pid}-${Date.now()}`,
);
const ARCHIVE_ROOT = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/project-tests/_archive",
);

type Fixture = {
  allowedRoot: string;
  database: Database;
  runtimeRoot: string;
  sourceRoot: string;
  store: StudioProjectStore;
};

function fixture(): Fixture {
  const root = resolve(TEMP_ROOT, crypto.randomUUID());
  const allowedRoot = resolve(root, "allowed");
  const sourceRoot = resolve(allowedRoot, "site");
  const runtimeRoot = resolve(root, "runtime");
  mkdirSync(resolve(sourceRoot, "src"), { recursive: true });
  writeFileSync(resolve(sourceRoot, "index.html"), "<h1>Original</h1>\n");
  writeFileSync(
    resolve(sourceRoot, "src/style.css"),
    "body { color: navy; }\n",
  );
  const database = new Database(":memory:", { strict: true });
  migrateDatabase(database);
  const store = new StudioProjectStore(database, {
    allowedSourceRoots: [allowedRoot],
    runtimeRoot,
  });
  return { allowedRoot, database, runtimeRoot, sourceRoot, store };
}

function expectProjectCode(action: () => unknown, code: ProjectError["code"]) {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectError);
    expect((error as ProjectError).code).toBe(code);
  }
}

afterAll(() => {
  mkdirSync(ARCHIVE_ROOT, { recursive: true });
  if (existsSync(TEMP_ROOT)) {
    renameSync(
      TEMP_ROOT,
      resolve(ARCHIVE_ROOT, `run-${Date.now()}-${crypto.randomUUID()}`),
    );
  }
});

describe("StudioProjectStore path boundary", () => {
  test("rejects an overlapping runtime root before it creates storage", () => {
    const root = resolve(TEMP_ROOT, crypto.randomUUID());
    const allowedRoot = resolve(root, "allowed");
    const sourceRoot = resolve(allowedRoot, "site");
    const invalidRuntimeRoot = resolve(allowedRoot, "future-runtime");
    mkdirSync(sourceRoot, { recursive: true });
    const database = new Database(":memory:", { strict: true });
    migrateDatabase(database);

    expectProjectCode(
      () =>
        new StudioProjectStore(database, {
          allowedSourceRoots: [allowedRoot],
          runtimeRoot: invalidRuntimeRoot,
        }),
      "PROJECT_RUNTIME_PATH_INVALID",
    );
    expect(existsSync(invalidRuntimeRoot)).toBe(false);
    database.close();
  });

  test("copies a nested source only into runtime storage without changing source", () => {
    const { database, runtimeRoot, sourceRoot, store } = fixture();
    const before = {
      html: readFileSync(resolve(sourceRoot, "index.html"), "utf8"),
      css: readFileSync(resolve(sourceRoot, "src/style.css"), "utf8"),
    };

    const project = store.createProject({
      slug: "site-one",
      title: "Site One",
      sourcePath: sourceRoot,
      idempotencyKey: "create-site-one",
    });

    expect(project.baselines).toHaveLength(1);
    const baseline = project.baselines[0];
    if (!baseline) throw new Error("Expected initial baseline");
    expect(baseline.fileCount).toBe(2);
    expect(
      resolve(runtimeRoot, baseline.snapshotPath).startsWith(runtimeRoot),
    ).toBe(true);
    expect(
      readFileSync(
        resolve(runtimeRoot, baseline.snapshotPath, "index.html"),
        "utf8",
      ),
    ).toBe(before.html);
    expect(
      readFileSync(
        resolve(runtimeRoot, baseline.snapshotPath, "src/style.css"),
        "utf8",
      ),
    ).toBe(before.css);
    writeFileSync(
      resolve(runtimeRoot, baseline.snapshotPath, "index.html"),
      "<h1>Snapshot edit</h1>\n",
    );
    expect(readFileSync(resolve(sourceRoot, "index.html"), "utf8")).toBe(
      before.html,
    );
    expect(readFileSync(resolve(sourceRoot, "src/style.css"), "utf8")).toBe(
      before.css,
    );
    database.close();
  });

  test("skips dependency, VCS, and archived working directories", () => {
    const { database, runtimeRoot, sourceRoot, store } = fixture();
    for (const directory of [".git", "node_modules", "_archive"]) {
      mkdirSync(resolve(sourceRoot, directory, "nested"), { recursive: true });
      writeFileSync(
        resolve(sourceRoot, directory, "nested/ignored.txt"),
        directory,
      );
    }
    const outside = resolve(sourceRoot, "outside.txt");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, resolve(sourceRoot, "_archive/nested/ignored-link"));

    const project = store.createProject({
      slug: "ignored-working-directories",
      title: "Ignored working directories",
      sourcePath: sourceRoot,
      idempotencyKey: "ignored-working-directories",
    });
    const baseline = project.baselines[0];
    if (!baseline) throw new Error("Expected initial baseline");
    expect(baseline.fileCount).toBe(3);
    for (const directory of [".git", "node_modules", "_archive"]) {
      expect(
        existsSync(resolve(runtimeRoot, baseline.snapshotPath, directory)),
      ).toBe(false);
    }
    database.close();
  });

  test("rejects traversal and sibling-prefix paths outside allowlisted roots", () => {
    const { allowedRoot, database, store } = fixture();
    const outside = resolve(allowedRoot, "..", "outside");
    const siblingPrefix = `${allowedRoot}-other`;
    mkdirSync(outside, { recursive: true });
    mkdirSync(siblingPrefix, { recursive: true });

    for (const sourcePath of [outside, siblingPrefix]) {
      expectProjectCode(
        () =>
          store.createProject({
            slug: `outside-${crypto.randomUUID()}`,
            title: "Outside",
            sourcePath,
            idempotencyKey: crypto.randomUUID(),
          }),
        "PROJECT_SOURCE_NOT_ALLOWED",
      );
    }
    database.close();
  });

  test("rejects a source symlink escape and a nested symlink escape", () => {
    const { allowedRoot, database, sourceRoot, store } = fixture();
    const outside = resolve(allowedRoot, "..", "secret");
    mkdirSync(outside, { recursive: true });
    writeFileSync(resolve(outside, "secret.txt"), "secret\n");
    const sourceLink = resolve(allowedRoot, "source-link");
    symlinkSync(outside, sourceLink);
    expectProjectCode(
      () =>
        store.createProject({
          slug: "source-link",
          title: "Source link",
          sourcePath: sourceLink,
          idempotencyKey: "source-link",
        }),
      "PROJECT_SOURCE_SYMLINK",
    );

    symlinkSync(
      resolve(outside, "secret.txt"),
      resolve(sourceRoot, "secret.txt"),
    );
    expectProjectCode(
      () =>
        store.createProject({
          slug: "nested-link",
          title: "Nested link",
          sourcePath: sourceRoot,
          idempotencyKey: "nested-link",
        }),
      "PROJECT_SOURCE_SYMLINK",
    );
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM site_projects",
        )
        .get()?.count,
    ).toBe(0);
    database.close();
  });

  test("rejects a symlinked runtime projects ancestor without touching its target", () => {
    const { database, runtimeRoot, sourceRoot, store } = fixture();
    const outside = resolve(runtimeRoot, "..", "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, resolve(runtimeRoot, "projects"));

    expectProjectCode(
      () =>
        store.createProject({
          slug: "runtime-link",
          title: "Runtime link",
          sourcePath: sourceRoot,
          idempotencyKey: "runtime-link",
        }),
      "PROJECT_RUNTIME_PATH_INVALID",
    );
    expect(existsSync(resolve(outside, "baselines"))).toBe(false);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM site_projects",
        )
        .get()?.count,
    ).toBe(0);
    database.close();
  });
});

describe("StudioProjectStore persistence", () => {
  test("returns the same project for an identical retry and conflicts on changed input", () => {
    const { database, sourceRoot, store } = fixture();
    const input = {
      slug: "retry-site",
      title: "Retry Site",
      sourcePath: sourceRoot,
      idempotencyKey: "retry-key",
    };
    const first = store.createProject(input);
    const second = store.createProject(input);
    expect(second.id).toBe(first.id);
    expect(second.baselines[0]?.id).toBe(first.baselines[0]?.id);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM site_projects",
        )
        .get()?.count,
    ).toBe(1);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM project_baselines",
        )
        .get()?.count,
    ).toBe(1);

    expectProjectCode(
      () => store.createProject({ ...input, title: "Changed" }),
      "PROJECT_CONFLICT",
    );
    database.close();
  });

  test("returns a valid persisted retry after its source has moved", () => {
    const { allowedRoot, database, sourceRoot, store } = fixture();
    const input = {
      slug: "moved-source",
      title: "Moved source",
      sourcePath: sourceRoot,
      idempotencyKey: "moved-source-key",
    };
    const first = store.createProject(input);
    renameSync(sourceRoot, resolve(allowedRoot, "moved-site"));

    expect(store.createProject(input).id).toBe(first.id);
    database.close();
  });

  test("does not accept an idempotent retry when its persisted runtime is missing", () => {
    const { database, runtimeRoot, sourceRoot, store } = fixture();
    const input = {
      slug: "missing-runtime",
      title: "Missing runtime",
      sourcePath: sourceRoot,
      idempotencyKey: "missing-runtime-key",
    };
    const project = store.createProject(input);
    renameSync(
      resolve(runtimeRoot, project.runtimePath),
      resolve(runtimeRoot, "lost-runtime"),
    );

    expectProjectCode(
      () => store.createProject(input),
      "PROJECT_RUNTIME_PATH_INVALID",
    );
    database.close();
  });

  test("rejects a new slug that aliases an existing project id", () => {
    const { database, sourceRoot, store } = fixture();
    const first = store.createProject({
      slug: "first-project",
      title: "First project",
      sourcePath: sourceRoot,
      idempotencyKey: "first-project-key",
    });
    const secondSource = resolve(sourceRoot, "..", "site-two");
    mkdirSync(secondSource, { recursive: true });
    writeFileSync(resolve(secondSource, "index.html"), "second\n");

    expectProjectCode(
      () =>
        store.createProject({
          slug: first.id,
          title: "Aliased id",
          sourcePath: secondSource,
          idempotencyKey: "aliased-id-key",
        }),
      "PROJECT_CONFLICT",
    );
    database.close();
  });

  test("creates idempotent later baselines and enforces optimistic updates", () => {
    const { database, sourceRoot, store } = fixture();
    const project = store.createProject({
      slug: "versioned-site",
      title: "Versioned Site",
      sourcePath: sourceRoot,
      idempotencyKey: "create-versioned",
    });
    writeFileSync(resolve(sourceRoot, "index.html"), "<h1>Revision two</h1>\n");
    const first = store.createBaseline(project.id, {
      idempotencyKey: "baseline-two",
    });
    renameSync(sourceRoot, resolve(sourceRoot, "..", "moved-source"));
    const retry = store.createBaseline(project.slug, {
      idempotencyKey: "baseline-two",
    });
    expect(first.revision).toBe(2);
    expect(retry.id).toBe(first.id);

    const updated = store.updateProject(project.id, {
      title: "Updated",
      expectedVersion: 1,
    });
    expect(updated.title).toBe("Updated");
    expect(updated.version).toBe(2);
    expectProjectCode(
      () =>
        store.updateProject(project.id, {
          title: "Stale",
          expectedVersion: 1,
        }),
      "PROJECT_CONFLICT",
    );
    database.close();
  });

  test("concurrent same-key baselines converge without removing the winner snapshot", async () => {
    const root = resolve(TEMP_ROOT, crypto.randomUUID());
    const allowedRoot = resolve(root, "allowed");
    const sourceRoot = resolve(allowedRoot, "site");
    const runtimeRoot = resolve(root, "runtime");
    const databasePath = resolve(root, "concurrent.sqlite");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(resolve(sourceRoot, "index.html"), "x".repeat(2_000_000));
    const database = new Database(databasePath, {
      create: true,
      strict: true,
    });
    migrateDatabase(database);
    const store = new StudioProjectStore(database, {
      allowedSourceRoots: [allowedRoot],
      runtimeRoot,
    });
    const project = store.createProject({
      slug: "concurrent-baseline",
      title: "Concurrent baseline",
      sourcePath: sourceRoot,
      idempotencyKey: "concurrent-project",
    });
    database.close();

    const goPath = resolve(root, "go");
    const workerScript = `
      import { writeFileSync, existsSync } from "node:fs";
      import { openDatabase } from "./src/server/database.ts";
      import { StudioProjectStore } from "./src/server/projects.ts";
      writeFileSync(process.env.READY_PATH, "ready");
      while (!existsSync(process.env.GO_PATH)) await Bun.sleep(5);
      const database = openDatabase(process.env.DATABASE_PATH);
      const store = new StudioProjectStore(database, {
        allowedSourceRoots: [process.env.ALLOWED_ROOT],
        runtimeRoot: process.env.RUNTIME_ROOT,
      });
      const baseline = store.createBaseline(process.env.PROJECT_ID, {
        idempotencyKey: "shared-baseline-key",
      });
      console.log(JSON.stringify(baseline));
      database.close();
    `;
    const workers = [0, 1].map((index) =>
      Bun.spawn([process.execPath, "-e", workerScript], {
        cwd: resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          ALLOWED_ROOT: allowedRoot,
          DATABASE_PATH: databasePath,
          GO_PATH: goPath,
          PROJECT_ID: project.id,
          READY_PATH: resolve(root, `ready-${index}`),
          RUNTIME_ROOT: runtimeRoot,
        },
        stderr: "pipe",
        stdout: "pipe",
      }),
    );
    const readyDeadline = Date.now() + 5_000;
    while (
      !existsSync(resolve(root, "ready-0")) ||
      !existsSync(resolve(root, "ready-1"))
    ) {
      if (Date.now() >= readyDeadline) {
        for (const worker of workers) worker.kill();
        throw new Error("Concurrent baseline workers did not become ready");
      }
      await Bun.sleep(5);
    }
    writeFileSync(goPath, "go");
    const exitCodes = await Promise.all(workers.map((worker) => worker.exited));
    const errors = await Promise.all(
      workers.map((worker) => new Response(worker.stderr).text()),
    );
    const baselines = await Promise.all(
      workers.map(async (worker) =>
        JSON.parse(await new Response(worker.stdout).text()),
      ),
    );

    expect(errors).toEqual(["", ""]);
    expect(exitCodes).toEqual([0, 0]);
    expect(baselines[0]?.id).toBe(baselines[1]?.id);
    const verification = new Database(databasePath, { strict: true });
    expect(
      verification
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM project_baselines",
        )
        .get()?.count,
    ).toBe(2);
    expect(
      existsSync(
        resolve(runtimeRoot, baselines[0]?.snapshotPath, "index.html"),
      ),
    ).toBe(true);
    verification.close();
  });

  test("deletes only runtime storage and leaves the canonical source unchanged", () => {
    const { database, runtimeRoot, sourceRoot, store } = fixture();
    const original = readFileSync(resolve(sourceRoot, "index.html"), "utf8");
    const project = store.createProject({
      slug: "delete-site",
      title: "Delete Site",
      sourcePath: sourceRoot,
      idempotencyKey: "delete-site",
    });
    expect(existsSync(resolve(runtimeRoot, project.runtimePath))).toBe(true);

    store.deleteProject(project.id, { expectedVersion: 1 });

    expect(existsSync(resolve(runtimeRoot, project.runtimePath))).toBe(false);
    expect(readFileSync(resolve(sourceRoot, "index.html"), "utf8")).toBe(
      original,
    );
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM site_projects",
        )
        .get()?.count,
    ).toBe(0);
    database.close();
  });

  test("rejects invalid update status and corrupted stored paths before delete mutation", () => {
    const { database, runtimeRoot, sourceRoot, store } = fixture();
    const project = store.createProject({
      slug: "corrupt-path",
      title: "Corrupt path",
      sourcePath: sourceRoot,
      idempotencyKey: "corrupt-path",
    });
    expectProjectCode(
      () =>
        store.updateProject(project.id, {
          status: "invalid",
          expectedVersion: 1,
        }),
      "PROJECT_INVALID_INPUT",
    );
    database
      .query("UPDATE site_projects SET runtime_path = ? WHERE id = ?")
      .run("projects/not-the-project", project.id);

    expectProjectCode(
      () => store.deleteProject(project.id, { expectedVersion: 1 }),
      "PROJECT_DATA_INVALID",
    );
    expect(existsSync(resolve(runtimeRoot, project.runtimePath))).toBe(true);
    database.close();
  });

  test("rejects corrupted baseline data before hydrating a project", () => {
    const { database, sourceRoot, store } = fixture();
    const project = store.createProject({
      slug: "corrupt-baseline",
      title: "Corrupt baseline",
      sourcePath: sourceRoot,
      idempotencyKey: "corrupt-baseline",
    });
    database
      .query(
        "UPDATE project_baselines SET snapshot_path = ? WHERE project_id = ?",
      )
      .run("../outside", project.id);

    expectProjectCode(
      () => store.getProject(project.id),
      "PROJECT_DATA_INVALID",
    );
    database.close();
  });

  test("archives an owned orphan baseline path and retries that revision", () => {
    const { database, runtimeRoot, sourceRoot, store } = fixture();
    const project = store.createProject({
      slug: "orphan-baseline",
      title: "Orphan baseline",
      sourcePath: sourceRoot,
      idempotencyKey: "orphan-baseline",
    });
    const orphan = resolve(runtimeRoot, project.runtimePath, "baselines", "2");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(resolve(orphan, "orphan.txt"), "orphan\n");
    writeFileSync(resolve(sourceRoot, "index.html"), "<h1>Revision two</h1>\n");

    const baseline = store.createBaseline(project.id, {
      idempotencyKey: "orphan-baseline-two",
    });
    expect(baseline.revision).toBe(2);
    expect(
      readFileSync(
        resolve(runtimeRoot, baseline.snapshotPath, "index.html"),
        "utf8",
      ),
    ).toBe("<h1>Revision two</h1>\n");
    expect(existsSync(resolve(runtimeRoot, "_archive"))).toBe(true);
    database.close();
  });

  test("refuses deletion when the runtime archive is a symlink", () => {
    const { database, runtimeRoot, sourceRoot, store } = fixture();
    const project = store.createProject({
      slug: "archive-link",
      title: "Archive link",
      sourcePath: sourceRoot,
      idempotencyKey: "archive-link",
    });
    const outside = resolve(runtimeRoot, "..", "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, resolve(runtimeRoot, "_archive"));

    expectProjectCode(
      () => store.deleteProject(project.id, { expectedVersion: 1 }),
      "PROJECT_RUNTIME_PATH_INVALID",
    );
    expect(existsSync(resolve(runtimeRoot, project.runtimePath))).toBe(true);
    expect(existsSync(resolve(outside, project.id))).toBe(false);
    database.close();
  });
});
