import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { workbenchTweakManifestSchema } from "../../src/shared/tweaks";
import { LocalAgentRunner } from "../../src/server/agent-runner";
import { createComparison } from "../../src/server/comparisons";
import { migrateDatabase } from "../../src/server/database";
import {
  GenerationError,
  generateComparisonVariant,
} from "../../src/server/generation";
import { StudioProjectStore } from "../../src/server/projects";
import { StudioService } from "../../src/server/studio";

const root = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/generation-tests",
  `${process.pid}-${Date.now()}`,
);
const archive = resolve(
  (process.env.TMPDIR ?? "/tmp") +
    "/design-workbench/generation-tests/_archive",
);

const brief = `# Glam-up proof

## Aesthetic family
Editorial systems

## Visual vocabulary
- measured
- tactile
- typographic
- quiet
- precise

## References and borrowed qualities
- Quiet ledgers: borrow pacing, not identity.

## Intent
Improve a local site through comparative design exploration.

## Audience
Prospective clients.

## Primary action
Start a conversation.

## Always
- Preserve real content

## Never
- Use generic SaaS blobs

## Open risks
- Thin visual evidence

## Final copy-ready generation prompt
Create a measured editorial glam-up.
`;

afterAll(() => {
  mkdirSync(archive, { recursive: true });
  if (existsSync(root)) {
    renameSync(
      root,
      resolve(archive, `run-${Date.now()}-${crypto.randomUUID()}`),
    );
  }
});

describe("local comparison generation", () => {
  test("copies the baseline, runs the bounded local agent, and registers output", async () => {
    const run = resolve(root, crypto.randomUUID());
    const allowed = resolve(run, "allowed");
    const source = resolve(allowed, "site");
    const runtime = resolve(run, "runtime");
    const generated = resolve(run, "generated");
    const executable = resolve(run, "fake-agent");
    const briefPath = resolve(run, "brief.md");
    mkdirSync(source, { recursive: true });
    mkdirSync(generated, { recursive: true });
    writeFileSync(resolve(source, "index.html"), "<h1>Owned baseline</h1>\n");
    writeFileSync(briefPath, brief);
    writeFileSync(
      executable,
      `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({type:"result", result:"generated"}) + "\\n");
`,
    );
    chmodSync(executable, 0o755);

    const database = new Database(":memory:", { strict: true });
    migrateDatabase(database);
    const projects = new StudioProjectStore(database, {
      allowedSourceRoots: [allowed],
      runtimeRoot: runtime,
    });
    const project = projects.createProject({
      slug: "owned-site",
      title: "Owned Site",
      sourcePath: source,
      idempotencyKey: "owned-site",
    });
    const comparison = createComparison(database, {
      brief: briefPath,
      directions: 1,
      generatedRoot: generated,
    });
    const studio = new StudioService(database);
    const round = studio.createRound(project.id, {
      stage: "wide-net",
      prompt: "Create one proof",
      payload: { optionCount: 1 },
      comparisonId: comparison.comparisonId,
      parentRoundId: null,
      idempotencyKey: "round-one",
    });
    studio.configureDirections(project.id, round.id, [
      {
        title: "Vast Quiet",
        aestheticFamily: "Vast Quiet / Cinematic",
        referenceIds: [],
      },
    ]);
    const runner = new LocalAgentRunner({
      executable,
      reviewRoots: [runtime],
      buildRoots: [runtime, generated],
    });

    const variant = await generateComparisonVariant({
      database,
      projects,
      studio,
      runner,
      projectRuntimeRoot: runtime,
      generatedVariantsRoot: generated,
      workbenchRoot: resolve(import.meta.dir, "../.."),
      comparisonId: comparison.comparisonId,
      directionId: comparison.directions[0]?.id ?? "missing",
      engine: "impeccable",
    });

    expect(variant.engine).toBe("impeccable");
    expect(variant.artifactPath).toContain("direction-1/impeccable");
    expect(
      readFileSync(
        resolve(generated, variant.artifactPath, "index.html"),
        "utf8",
      ),
    ).toContain("Owned baseline");
    expect(
      existsSync(
        resolve(
          generated,
          variant.artifactPath,
          ".claude/skills/impeccable/SKILL.md",
        ),
      ),
    ).toBe(true);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM agent_messages",
        )
        .get()?.count,
    ).toBe(2);
    database.close();
  });

  test("archives the failed partial output and lets the retry succeed", async () => {
    const run = resolve(root, crypto.randomUUID());
    const allowed = resolve(run, "allowed");
    const source = resolve(allowed, "site");
    const runtime = resolve(run, "runtime");
    const generated = resolve(run, "generated");
    const executable = resolve(run, "fake-agent");
    const sentinel = resolve(run, "sentinel");
    const briefPath = resolve(run, "brief.md");
    mkdirSync(source, { recursive: true });
    mkdirSync(generated, { recursive: true });
    writeFileSync(resolve(source, "index.html"), "<h1>Owned baseline</h1>\n");
    writeFileSync(briefPath, brief);
    // First invocation exits non-zero (post-preparation failure); once the
    // sentinel exists, later invocations succeed. Deterministic because the
    // retry only runs after the first attempt has thrown.
    writeFileSync(
      executable,
      `#!/usr/bin/env bun
import { existsSync, writeFileSync } from "node:fs";
const sentinel = ${JSON.stringify(sentinel)};
if (!existsSync(sentinel)) {
  writeFileSync(sentinel, "seen");
  process.exit(3);
}
process.stdout.write(JSON.stringify({type:"result", result:"generated"}) + "\\n");
`,
    );
    chmodSync(executable, 0o755);

    const database = new Database(":memory:", { strict: true });
    migrateDatabase(database);
    const projects = new StudioProjectStore(database, {
      allowedSourceRoots: [allowed],
      runtimeRoot: runtime,
    });
    const project = projects.createProject({
      slug: "owned-site",
      title: "Owned Site",
      sourcePath: source,
      idempotencyKey: "owned-site",
    });
    const comparison = createComparison(database, {
      brief: briefPath,
      directions: 1,
      generatedRoot: generated,
    });
    const studio = new StudioService(database);
    const round = studio.createRound(project.id, {
      stage: "wide-net",
      prompt: "Create one proof",
      payload: { optionCount: 1 },
      comparisonId: comparison.comparisonId,
      parentRoundId: null,
      idempotencyKey: "round-one",
    });
    studio.configureDirections(project.id, round.id, [
      {
        title: "Vast Quiet",
        aestheticFamily: "Vast Quiet / Cinematic",
        referenceIds: [],
      },
    ]);
    const runner = new LocalAgentRunner({
      executable,
      reviewRoots: [runtime],
      buildRoots: [runtime, generated],
    });

    const request = {
      database,
      projects,
      studio,
      runner,
      projectRuntimeRoot: runtime,
      generatedVariantsRoot: generated,
      workbenchRoot: resolve(import.meta.dir, "../.."),
      comparisonId: comparison.comparisonId,
      directionId: comparison.directions[0]?.id ?? "missing",
      engine: "impeccable" as const,
    };

    // First attempt fails after output preparation.
    await expect(generateComparisonVariant(request)).rejects.toThrow();

    // The failed partial output was archived (not left behind), so the cell is
    // prepared and empty again for the retry.
    const cell = resolve(
      generated,
      comparison.comparisonId,
      "direction-1",
      "impeccable",
    );
    expect(existsSync(cell)).toBe(true);
    expect(readdirSync(cell).length).toBe(0);
    expect(readdirSync(resolve(generated, "_archive")).length).toBeGreaterThan(
      0,
    );

    // Retry succeeds against the reset cell.
    const variant = await generateComparisonVariant(request);
    expect(variant.engine).toBe("impeccable");
    expect(variant.artifactPath).toContain("direction-1/impeccable");
    expect(
      readFileSync(
        resolve(generated, variant.artifactPath, "index.html"),
        "utf8",
      ),
    ).toContain("Owned baseline");
    database.close();
  });

  test("normalizes a generated manifest so a successful generation is always servable", async () => {
    const run = resolve(root, crypto.randomUUID());
    const allowed = resolve(run, "allowed");
    const source = resolve(allowed, "site");
    const runtime = resolve(run, "runtime");
    const generated = resolve(run, "generated");
    const executable = resolve(run, "fake-agent");
    const briefPath = resolve(run, "brief.md");
    mkdirSync(source, { recursive: true });
    mkdirSync(generated, { recursive: true });
    writeFileSync(resolve(source, "index.html"), "<h1>Owned baseline</h1>\n");
    writeFileSync(briefPath, brief);
    // Emit the exact near-miss shape real generators produced: `tweaks`,
    // `cssCustomProperty`, `value`, a `decision` note, and no variantId.
    writeFileSync(
      executable,
      `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync("workbench.json", JSON.stringify({
  version: 1,
  name: "Generated",
  tweaks: [
    { id: "accent", label: "Accent", cssCustomProperty: "--accent",
      type: "color", value: "#3366ff", decision: "One signal color." },
  ],
}));
process.stdout.write(JSON.stringify({type:"result", result:"generated"}) + "\\n");
`,
    );
    chmodSync(executable, 0o755);

    const database = new Database(":memory:", { strict: true });
    migrateDatabase(database);
    const projects = new StudioProjectStore(database, {
      allowedSourceRoots: [allowed],
      runtimeRoot: runtime,
    });
    const project = projects.createProject({
      slug: "owned-site",
      title: "Owned Site",
      sourcePath: source,
      idempotencyKey: "owned-site",
    });
    const comparison = createComparison(database, {
      brief: briefPath,
      directions: 1,
      generatedRoot: generated,
    });
    const studio = new StudioService(database);
    const round = studio.createRound(project.id, {
      stage: "wide-net",
      prompt: "Create one proof",
      payload: { optionCount: 1 },
      comparisonId: comparison.comparisonId,
      parentRoundId: null,
      idempotencyKey: "round-one",
    });
    studio.configureDirections(project.id, round.id, [
      {
        title: "Vast Quiet",
        aestheticFamily: "Vast Quiet / Cinematic",
        referenceIds: [],
      },
    ]);
    const runner = new LocalAgentRunner({
      executable,
      reviewRoots: [runtime],
      buildRoots: [runtime, generated],
    });

    const variant = await generateComparisonVariant({
      database,
      projects,
      studio,
      runner,
      projectRuntimeRoot: runtime,
      generatedVariantsRoot: generated,
      workbenchRoot: resolve(import.meta.dir, "../.."),
      comparisonId: comparison.comparisonId,
      directionId: comparison.directions[0]?.id ?? "missing",
      engine: "impeccable",
    });

    // The registered artifact's manifest is rewritten into the canonical shape
    // and bound to the path the variant server will serve it from.
    const manifest = JSON.parse(
      readFileSync(
        resolve(generated, variant.artifactPath, "workbench.json"),
        "utf8",
      ),
    );
    expect(manifest.variantId).toBe(variant.artifactPath);
    expect(manifest.controls).toHaveLength(1);
    expect(manifest.controls[0].property).toBe("--accent");
    expect(manifest.controls[0].default).toBe("#3366ff");
    expect(manifest.controls[0]).not.toHaveProperty("cssCustomProperty");
    expect(() => workbenchTweakManifestSchema.parse(manifest)).not.toThrow();
    database.close();
  });

  test("fails generation when the manifest declares an unsupported control", async () => {
    const run = resolve(root, crypto.randomUUID());
    const allowed = resolve(run, "allowed");
    const source = resolve(allowed, "site");
    const runtime = resolve(run, "runtime");
    const generated = resolve(run, "generated");
    const executable = resolve(run, "fake-agent");
    const briefPath = resolve(run, "brief.md");
    mkdirSync(source, { recursive: true });
    mkdirSync(generated, { recursive: true });
    writeFileSync(resolve(source, "index.html"), "<h1>Owned baseline</h1>\n");
    writeFileSync(briefPath, brief);
    // The unsupported `length` control is the exact defect that produced
    // registered-but-unservable proofs.
    writeFileSync(
      executable,
      `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync("workbench.json", JSON.stringify({
  version: 1,
  tweaks: [
    { id: "page-gutter", label: "Gutter", cssCustomProperty: "--gutter",
      type: "length", value: "clamp(1rem, 3.2vw, 3.5rem)" },
  ],
}));
process.stdout.write(JSON.stringify({type:"result", result:"generated"}) + "\\n");
`,
    );
    chmodSync(executable, 0o755);

    const database = new Database(":memory:", { strict: true });
    migrateDatabase(database);
    const projects = new StudioProjectStore(database, {
      allowedSourceRoots: [allowed],
      runtimeRoot: runtime,
    });
    const project = projects.createProject({
      slug: "owned-site",
      title: "Owned Site",
      sourcePath: source,
      idempotencyKey: "owned-site",
    });
    const comparison = createComparison(database, {
      brief: briefPath,
      directions: 1,
      generatedRoot: generated,
    });
    const studio = new StudioService(database);
    const round = studio.createRound(project.id, {
      stage: "wide-net",
      prompt: "Create one proof",
      payload: { optionCount: 1 },
      comparisonId: comparison.comparisonId,
      parentRoundId: null,
      idempotencyKey: "round-one",
    });
    studio.configureDirections(project.id, round.id, [
      {
        title: "Vast Quiet",
        aestheticFamily: "Vast Quiet / Cinematic",
        referenceIds: [],
      },
    ]);
    const runner = new LocalAgentRunner({
      executable,
      reviewRoots: [runtime],
      buildRoots: [runtime, generated],
    });

    const request = {
      database,
      projects,
      studio,
      runner,
      projectRuntimeRoot: runtime,
      generatedVariantsRoot: generated,
      workbenchRoot: resolve(import.meta.dir, "../.."),
      comparisonId: comparison.comparisonId,
      directionId: comparison.directions[0]?.id ?? "missing",
      engine: "impeccable" as const,
    };

    const failure = await generateComparisonVariant(request).then(
      () => null,
      (error: unknown) => error as GenerationError,
    );
    expect(failure).toBeInstanceOf(GenerationError);
    expect(failure?.code).toBe("GENERATION_OUTPUT_INVALID");

    // No dead proof was registered, and the cell is reset for a retry.
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM variants")
        .get()?.count,
    ).toBe(0);
    const cell = resolve(
      generated,
      comparison.comparisonId,
      "direction-1",
      "impeccable",
    );
    expect(readdirSync(cell).length).toBe(0);
    database.close();
  });

  test("rejects an overlapping generation for the same cell with 409/GENERATION_CONFLICT", async () => {
    const run = resolve(root, crypto.randomUUID());
    const allowed = resolve(run, "allowed");
    const source = resolve(allowed, "site");
    const runtime = resolve(run, "runtime");
    const generated = resolve(run, "generated");
    const executable = resolve(run, "fake-agent");
    const briefPath = resolve(run, "brief.md");
    mkdirSync(source, { recursive: true });
    mkdirSync(generated, { recursive: true });
    writeFileSync(resolve(source, "index.html"), "<h1>Owned baseline</h1>\n");
    writeFileSync(briefPath, brief);
    // Sleep briefly so the first (holding) generation is still awaiting the
    // runner when the overlapping request reaches the owning-boundary guard.
    writeFileSync(
      executable,
      `#!/usr/bin/env bun
await Bun.sleep(150);
process.stdout.write(JSON.stringify({type:"result", result:"generated"}) + "\\n");
`,
    );
    chmodSync(executable, 0o755);

    const database = new Database(":memory:", { strict: true });
    migrateDatabase(database);
    const projects = new StudioProjectStore(database, {
      allowedSourceRoots: [allowed],
      runtimeRoot: runtime,
    });
    const project = projects.createProject({
      slug: "owned-site",
      title: "Owned Site",
      sourcePath: source,
      idempotencyKey: "owned-site",
    });
    const comparison = createComparison(database, {
      brief: briefPath,
      directions: 1,
      generatedRoot: generated,
    });
    const studio = new StudioService(database);
    const round = studio.createRound(project.id, {
      stage: "wide-net",
      prompt: "Create one proof",
      payload: { optionCount: 1 },
      comparisonId: comparison.comparisonId,
      parentRoundId: null,
      idempotencyKey: "round-one",
    });
    studio.configureDirections(project.id, round.id, [
      {
        title: "Vast Quiet",
        aestheticFamily: "Vast Quiet / Cinematic",
        referenceIds: [],
      },
    ]);
    const runner = new LocalAgentRunner({
      executable,
      reviewRoots: [runtime],
      buildRoots: [runtime, generated],
    });

    const request = {
      database,
      projects,
      studio,
      runner,
      projectRuntimeRoot: runtime,
      generatedVariantsRoot: generated,
      workbenchRoot: resolve(import.meta.dir, "../.."),
      comparisonId: comparison.comparisonId,
      directionId: comparison.directions[0]?.id ?? "missing",
      engine: "impeccable" as const,
    };

    // Fire the first generation without awaiting; it acquires the cell lock
    // synchronously before its first await, then start the overlapping one.
    const first = generateComparisonVariant(request);
    const overlap = generateComparisonVariant(request).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const overlapResult = await overlap;
    expect(overlapResult.ok).toBe(false);
    if (!overlapResult.ok) {
      const error = overlapResult.error as GenerationError;
      expect(error).toBeInstanceOf(GenerationError);
      expect(error.code).toBe("GENERATION_CONFLICT");
    }

    // The holding generation still completes and registers normally, proving
    // the lock released and the happy path is preserved.
    const variant = await first;
    expect(variant.engine).toBe("impeccable");
    expect(variant.artifactPath).toContain("direction-1/impeccable");
    database.close();
  });
});
