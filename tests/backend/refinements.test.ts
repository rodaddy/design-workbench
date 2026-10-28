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
import { LocalAgentRunner } from "../../src/server/agent-runner";
import { createComparison } from "../../src/server/comparisons";
import { migrateDatabase } from "../../src/server/database";
import { GenerationError } from "../../src/server/generation";
import { StudioProjectStore } from "../../src/server/projects";
import {
  generateRefinementOption,
  refinementArtifactPath,
  resolveRefinementParent,
  REFINEMENT_LENSES,
} from "../../src/server/refinements";
import { StudioService } from "../../src/server/studio";
import { registerVariant } from "../../src/server/variants";
import { workbenchTweakManifestSchema } from "../../src/shared/tweaks";

const root = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/refinement-tests",
  `${process.pid}-${Date.now()}`,
);
const archive = resolve(
  (process.env.TMPDIR ?? "/tmp") +
    "/design-workbench/refinement-tests/_archive",
);

const brief = `# Refinement proof

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
Prove refinement lineage.

## Audience
Operators.

## Primary action
Choose a refinement.

## Always
- Preserve real content

## Never
- Mutate the parent proof

## Open risks
- None

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

/**
 * A comparison whose direction 1 already has a registered Impeccable proof —
 * the state a refinement round branches from.
 */
function scenario(agentScript: string) {
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
  writeFileSync(executable, agentScript);
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
    directions: 5,
    generatedRoot: generated,
  });
  const studio = new StudioService(database);
  const wideNet = studio.createRound(project.id, {
    stage: "wide-net",
    prompt: "Five directions",
    payload: { optionCount: 5 },
    comparisonId: comparison.comparisonId,
    parentRoundId: null,
    idempotencyKey: "round-one",
  });

  // Register a real parent proof for direction 1.
  const direction = comparison.directions[0];
  const parentCell = resolve(
    generated,
    comparison.comparisonId,
    "direction-1",
    "impeccable",
  );
  mkdirSync(parentCell, { recursive: true });
  writeFileSync(
    resolve(parentCell, "index.html"),
    "<h1>Chosen direction proof</h1>\n",
  );
  registerVariant(database, {
    comparison: comparison.comparisonId,
    direction: direction?.id ?? "",
    engine: "impeccable",
    path: parentCell,
    generatedRoot: generated,
  });

  const refinementRound = studio.createRefinement({
    comparisonId: comparison.comparisonId,
    directionId: direction?.id ?? "",
    idempotencyKey: "refine-one",
  });

  return {
    database,
    projects,
    studio,
    project,
    comparison,
    wideNet,
    refinementRound,
    generated,
    runtime,
    parentCell,
    runner: new LocalAgentRunner({
      executable,
      reviewRoots: [runtime],
      buildRoots: [runtime, generated],
    }),
  };
}

const WRITES_MANIFEST = `#!/usr/bin/env bun
import { writeFileSync, readFileSync } from "node:fs";
writeFileSync("index.html", readFileSync("index.html", "utf8") + "<!-- refined -->");
writeFileSync("workbench.json", JSON.stringify({
  version: 1,
  tweaks: [
    { id: "accent", label: "Accent", cssCustomProperty: "--accent",
      type: "color", value: "#3366ff" },
  ],
}));
process.stdout.write(JSON.stringify({type:"result", result:"refined"}) + "\\n");
`;

describe("refinement parent resolution", () => {
  test("resolves the chosen direction's registered proof", () => {
    const context = scenario(WRITES_MANIFEST);
    const target = resolveRefinementParent(
      context.database,
      context.refinementRound.id,
    );

    expect(target.directionSlug).toBe("direction-1");
    expect(target.engine).toBe("impeccable");
    expect(target.parentArtifactPath).toContain("direction-1/impeccable");
    expect(target.comparisonId).toBe(context.comparison.comparisonId);
    context.database.close();
  });

  test("refuses to refine a direction that has no registered proof", () => {
    const context = scenario(WRITES_MANIFEST);
    // Direction 2 was never generated, so there is nothing to branch from.
    const second = context.comparison.directions[1];
    const round = context.studio.createRefinement({
      comparisonId: context.comparison.comparisonId,
      directionId: second?.id ?? "",
      idempotencyKey: "refine-two",
    });

    let caught: unknown;
    try {
      resolveRefinementParent(context.database, round.id);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GenerationError);
    expect((caught as GenerationError).code).toBe("GENERATION_NOT_FOUND");
    context.database.close();
  });

  test("gives each lens its own artifact path", () => {
    const context = scenario(WRITES_MANIFEST);
    const target = resolveRefinementParent(
      context.database,
      context.refinementRound.id,
    );
    const paths = REFINEMENT_LENSES.map((lens) =>
      refinementArtifactPath(target, lens),
    );
    expect(new Set(paths).size).toBe(3);
    expect(paths[0]).toContain("refinements/option-1");
    context.database.close();
  });
});

describe("refinement generation", () => {
  test("branches from the parent proof without mutating it", async () => {
    const context = scenario(WRITES_MANIFEST);
    const target = resolveRefinementParent(
      context.database,
      context.refinementRound.id,
    );
    const parentBefore = readFileSync(
      resolve(context.parentCell, "index.html"),
      "utf8",
    );

    const lens = REFINEMENT_LENSES[0];
    const result = await generateRefinementOption({
      database: context.database,
      studio: context.studio,
      runner: context.runner,
      generatedVariantsRoot: context.generated,
      workbenchRoot: resolve(import.meta.dir, "../.."),
      projectId: context.project.id,
      target,
      lens: lens!,
      brief,
    });

    // The refinement carries the parent's content forward and adds to it.
    const refined = readFileSync(
      resolve(context.generated, result.artifactPath, "index.html"),
      "utf8",
    );
    expect(refined).toContain("Chosen direction proof");
    expect(refined).toContain("refined");

    // The parent proof is immutable exploration evidence.
    expect(
      readFileSync(resolve(context.parentCell, "index.html"), "utf8"),
    ).toBe(parentBefore);
    context.database.close();
  });

  test("normalizes the refined manifest so the option is servable", async () => {
    const context = scenario(WRITES_MANIFEST);
    const target = resolveRefinementParent(
      context.database,
      context.refinementRound.id,
    );
    const lens = REFINEMENT_LENSES[1];
    const result = await generateRefinementOption({
      database: context.database,
      studio: context.studio,
      runner: context.runner,
      generatedVariantsRoot: context.generated,
      workbenchRoot: resolve(import.meta.dir, "../.."),
      projectId: context.project.id,
      target,
      lens: lens!,
    });

    const manifest = JSON.parse(
      readFileSync(
        resolve(context.generated, result.artifactPath, "workbench.json"),
        "utf8",
      ),
    );
    expect(manifest.variantId).toBe(result.artifactPath);
    expect(() => workbenchTweakManifestSchema.parse(manifest)).not.toThrow();
    context.database.close();
  });

  test("fails the option and resets its cell when the agent writes no index.html", async () => {
    const context = scenario(`#!/usr/bin/env bun
import { rmSync } from "node:fs";
rmSync("index.html");
process.stdout.write(JSON.stringify({type:"result", result:"broke it"}) + "\\n");
`);
    const target = resolveRefinementParent(
      context.database,
      context.refinementRound.id,
    );
    const lens = REFINEMENT_LENSES[2];

    const failure = await generateRefinementOption({
      database: context.database,
      studio: context.studio,
      runner: context.runner,
      generatedVariantsRoot: context.generated,
      workbenchRoot: resolve(import.meta.dir, "../.."),
      projectId: context.project.id,
      target,
      lens: lens!,
    }).then(
      () => null,
      (error: unknown) => error as GenerationError,
    );

    expect(failure).toBeInstanceOf(GenerationError);
    expect(failure?.code).toBe("GENERATION_OUTPUT_INVALID");
    // The cell is prepared and empty so a retry can succeed.
    const cell = resolve(
      context.generated,
      refinementArtifactPath(target, lens!),
    );
    expect(readdirSync(cell).length).toBe(0);
    context.database.close();
  });
});
