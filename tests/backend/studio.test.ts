import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApiFetchHandler } from "../../src/server/api";
import { migrateDatabase } from "../../src/server/database";
import { StudioProjectStore } from "../../src/server/projects";
import { StudioService } from "../../src/server/studio";

const root = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/studio-tests",
  `${process.pid}-${Date.now()}`,
);
const archive = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/studio-tests/_archive",
);

function fixture() {
  const run = resolve(root, crypto.randomUUID());
  const allowed = resolve(run, "allowed");
  const source = resolve(allowed, "site");
  const runtime = resolve(run, "runtime");
  mkdirSync(source, { recursive: true });
  writeFileSync(resolve(source, "index.html"), "<h1>Baseline</h1>\n");
  const database = new Database(":memory:", { strict: true });
  migrateDatabase(database);
  const projects = new StudioProjectStore(database, {
    allowedSourceRoots: [allowed],
    runtimeRoot: runtime,
  });
  const project = projects.createProject({
    slug: "studio-site",
    title: "Studio Site",
    sourcePath: source,
    idempotencyKey: "studio-site",
  });
  return {
    allowed,
    database,
    project,
    runtime,
    service: new StudioService(database),
  };
}

afterAll(() => {
  mkdirSync(archive, { recursive: true });
  if (existsSync(root)) {
    renameSync(
      root,
      resolve(archive, `run-${Date.now()}-${crypto.randomUUID()}`),
    );
  }
});

describe("Studio exploration lineage", () => {
  test("records a wide-net round and a three-option refinement child", () => {
    const { database, project, service } = fixture();
    const wide = service.createRound(project.id, {
      stage: "wide-net",
      prompt: "Create five directions",
      payload: { optionCount: 5 },
      comparisonId: null,
      parentRoundId: null,
      idempotencyKey: "wide-net-1",
    });
    const refinement = service.createRound(project.id, {
      stage: "refinement",
      prompt: "Create three versions of Vast Quiet",
      payload: { optionCount: 3 },
      comparisonId: null,
      parentRoundId: wide.id,
      idempotencyKey: "refinement-1",
    });

    expect(service.listRounds(project.id).map((round) => round.stage)).toEqual([
      "wide-net",
      "refinement",
    ]);
    expect(
      database
        .query<{ depth: number }, [string, string, string]>(
          `SELECT depth FROM exploration_round_lineage
           WHERE project_id = ? AND ancestor_round_id = ? AND descendant_round_id = ?`,
        )
        .get(project.id, wide.id, refinement.id)?.depth,
    ).toBe(1);
    expect(
      typeof service.createSelection(project.id, wide.id, {
        directionKey: "vast-quiet",
        comparisonDirectionId: null,
        title: "Vast Quiet",
        rationale: "Strongest fit",
        position: 2,
        payload: {},
        idempotencyKey: "select-vast-quiet",
      }).id,
    ).toBe("string");
    database.close();
  });

  test("chooses a comparison direction and creates one idempotent three-option child", () => {
    const { database, project, service } = fixture();
    const now = new Date().toISOString();
    database
      .query(
        `INSERT INTO comparisons (
          id, slug, title, source_brief_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, 'draft', ?, ?)`,
      )
      .run("comparison-1", "comparison-1", "Five directions", now, now);
    database
      .query(
        `INSERT INTO aesthetic_directions (
          id, comparison_id, slug, title, position, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, '{}', ?)`,
      )
      .run("direction-3", "comparison-1", "direction-3", "Vast Quiet", 2, now);
    const wide = service.createRound(project.id, {
      stage: "wide-net",
      prompt: "Create five directions",
      payload: { optionCount: 5 },
      comparisonId: "comparison-1",
      parentRoundId: null,
      idempotencyKey: "wide-net-comparison-1",
    });

    const refinement = service.createRefinement({
      comparisonId: "comparison-1",
      directionId: "direction-3",
      idempotencyKey: "choose-direction-3",
    });
    const repeated = service.createRefinement({
      comparisonId: "comparison-1",
      directionId: "direction-3",
      idempotencyKey: "choose-direction-3",
    });

    expect(repeated.id).toBe(refinement.id);
    expect(refinement.stage).toBe("refinement");
    expect(refinement.payload.optionCount).toBe(3);
    expect(refinement.payload.directionId).toBe("direction-3");
    expect(refinement.payload.options).toHaveLength(3);
    expect(service.listRounds(project.id)).toHaveLength(2);
    expect(service.listRounds(project.id)[0]).toEqual(wide);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM direction_selections",
        )
        .get()?.count,
    ).toBe(1);
    expect(
      database
        .query<{ depth: number }, [string, string, string]>(
          `SELECT depth FROM exploration_round_lineage
           WHERE project_id = ? AND ancestor_round_id = ? AND descendant_round_id = ?`,
        )
        .get(project.id, wide.id, refinement.id)?.depth,
    ).toBe(1);
    database.close();
  });

  test("exposes direction refinement through the trusted API boundary", async () => {
    const { allowed, database, project, runtime, service } = fixture();
    const now = new Date().toISOString();
    database
      .query(
        `INSERT INTO comparisons (
          id, slug, title, source_brief_id, status, created_at, updated_at
        ) VALUES ('comparison-api', 'comparison-api', 'API directions', NULL, 'draft', ?, ?)`,
      )
      .run(now, now);
    database
      .query(
        `INSERT INTO aesthetic_directions (
          id, comparison_id, slug, title, position, metadata, created_at
        ) VALUES ('direction-api', 'comparison-api', 'direction-api', 'Dither Mono', 0, '{}', ?)`,
      )
      .run(now);
    const wide = service.createRound(project.id, {
      stage: "wide-net",
      prompt: "",
      payload: { optionCount: 5 },
      comparisonId: "comparison-api",
      parentRoundId: null,
      idempotencyKey: "wide-api",
    });
    const handler = createApiFetchHandler({
      database,
      assetRoot: allowed,
      generatedVariantsRoot: allowed,
      allowedOrigins: ["http://127.0.0.1:5173"],
      projectStorage: {
        allowedSourceRoots: [allowed],
        runtimeRoot: runtime,
      },
    });

    const response = await handler(
      new Request(
        "http://127.0.0.1:3000/api/comparisons/comparison-api/directions/direction-api/refinements",
        {
          method: "POST",
          headers: {
            Origin: "http://127.0.0.1:5173",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ idempotencyKey: "api-refinement" }),
        },
      ),
    );
    const body = (await response.json()) as {
      stage: string;
      payload: { optionCount: number };
    };

    expect(response.status).toBe(201);
    expect(body.stage).toBe("refinement");
    expect(body.payload.optionCount).toBe(3);
    expect(service.listRounds(project.id)[0]).toEqual(wide);
    database.close();
  });
});

describe("Studio agent persistence", () => {
  test("persists a resumable user and assistant conversation", () => {
    const { database, project, service } = fixture();
    const session = service.createSession(project.id, {
      roundId: null,
      metadata: { purpose: "reference-discussion" },
      idempotencyKey: "session-1",
    });
    const run = service.startRun(session.id, "What do these examples share?");
    const completed = service.finishRun(session.id, run.runId, {
      text: "They share a restrained editorial hierarchy.",
    });

    expect(completed.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(completed.messages[1]?.content).toContain("editorial hierarchy");
    expect(service.getSession(session.id).messages).toHaveLength(2);
    database.close();
  });
});
