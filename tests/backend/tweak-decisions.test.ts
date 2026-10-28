import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { LocalAgentRunner } from "../../src/server/agent-runner";
import {
  applyTweakRevision,
  declarationFor,
  listRevisions,
} from "../../src/server/artifact-revisions";
import { createComparison } from "../../src/server/comparisons";
import { migrateDatabase } from "../../src/server/database";
import { StudioProjectStore } from "../../src/server/projects";
import { StudioService } from "../../src/server/studio";
import {
  TweakDecisionError,
  TweakDecisionStore,
  validateDecisions,
} from "../../src/server/tweak-decisions";
import { registerVariant } from "../../src/server/variants";
import { workbenchTweakManifestSchema } from "../../src/shared/tweaks";

const root = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/tweak-tests",
  `${process.pid}-${Date.now()}`,
);
const archive = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/tweak-tests/_archive",
);

const brief = `# Tweak proof

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
Prove tweak persistence.

## Audience
Operators.

## Primary action
Save decisions.

## Always
- Preserve real content

## Never
- Mutate the parent proof

## Open risks
- None

## Final copy-ready generation prompt
Create a measured editorial glam-up.
`;

const MANIFEST = {
  version: 1,
  variantId: "placeholder",
  controls: [
    {
      id: "accent",
      label: "Accent",
      property: "--accent",
      affectsMotion: false,
      type: "color",
      default: "#3366ff",
    },
    {
      id: "page-margin",
      label: "Page margin",
      property: "--page-margin",
      affectsMotion: false,
      type: "number",
      min: 0,
      max: 8,
      step: 0.25,
      unit: "rem",
      default: 2,
    },
    {
      id: "motion",
      label: "Motion",
      property: "--motion",
      affectsMotion: true,
      type: "boolean",
      default: true,
    },
  ],
};

afterAll(() => {
  mkdirSync(archive, { recursive: true });
  if (existsSync(root)) {
    renameSync(
      root,
      resolve(archive, `run-${Date.now()}-${crypto.randomUUID()}`),
    );
  }
});

function scenario(
  agentScript = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({type:"result", result:"applied"}) + "\\n");
`,
) {
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
    directions: 1,
    generatedRoot: generated,
  });
  const studio = new StudioService(database);
  studio.createRound(project.id, {
    stage: "wide-net",
    prompt: "One direction",
    payload: {},
    comparisonId: comparison.comparisonId,
    parentRoundId: null,
    idempotencyKey: "round-one",
  });

  const artifactPath = `${comparison.comparisonId}/direction-1/impeccable`;
  const cell = resolve(generated, artifactPath);
  mkdirSync(resolve(cell, "assets"), { recursive: true });
  writeFileSync(resolve(cell, "index.html"), "<h1>Proof</h1>\n");
  writeFileSync(
    resolve(cell, "assets", "site.css"),
    ":root { --accent: #3366ff; --page-margin: 2rem; --motion: 1; }\n",
  );
  writeFileSync(
    resolve(cell, "workbench.json"),
    JSON.stringify({ ...MANIFEST, variantId: artifactPath }, null, 2),
  );
  const variant = registerVariant(database, {
    comparison: comparison.comparisonId,
    direction: comparison.directions[0]?.id ?? "",
    engine: "impeccable",
    path: cell,
    generatedRoot: generated,
  });

  return {
    database,
    studio,
    project,
    variant,
    generated,
    cell,
    artifactPath,
    store: new TweakDecisionStore(database, generated),
    runner: new LocalAgentRunner({
      executable,
      reviewRoots: [runtime],
      buildRoots: [runtime, generated],
    }),
  };
}

describe("tweak decision validation", () => {
  const manifest = workbenchTweakManifestSchema.parse({
    ...MANIFEST,
    variantId: "example",
  });

  test("accepts values each control would apply", () => {
    expect(
      validateDecisions(manifest, {
        accent: "#ff0000",
        "page-margin": 3.25,
        motion: false,
      }),
    ).toEqual({ accent: "#ff0000", "page-margin": 3.25, motion: false });
  });

  test("rejects an unknown control instead of dropping it", () => {
    // A silently discarded decision looks saved but never applies.
    expect(() => validateDecisions(manifest, { nope: "#ff0000" })).toThrow(
      TweakDecisionError,
    );
  });

  test("rejects a value the control's own bounds forbid", () => {
    expect(() => validateDecisions(manifest, { "page-margin": 99 })).toThrow(
      TweakDecisionError,
    );
    // Off-step values are refused for the same reason.
    expect(() => validateDecisions(manifest, { "page-margin": 2.1 })).toThrow(
      TweakDecisionError,
    );
  });

  test("rejects a malformed color", () => {
    expect(() => validateDecisions(manifest, { accent: "red" })).toThrow(
      TweakDecisionError,
    );
  });
});

describe("tweak decision persistence", () => {
  test("saves and reads back a decision set", () => {
    const context = scenario();
    const saved = context.store.save({
      variantId: context.variant.id,
      label: "Warmer accent",
      decisions: { accent: "#ff8800", "page-margin": 2.5 },
      idempotencyKey: "first",
    });

    expect(saved.label).toBe("Warmer accent");
    expect(saved.decisions).toEqual({
      accent: "#ff8800",
      "page-margin": 2.5,
    });
    expect(context.store.listForVariant(context.variant.id)).toHaveLength(1);
    context.database.close();
  });

  test("is idempotent for a repeated save", () => {
    const context = scenario();
    const request = {
      variantId: context.variant.id,
      label: "Same",
      decisions: { accent: "#ff8800" },
      idempotencyKey: "repeat",
    };
    expect(context.store.save(request).id).toBe(context.store.save(request).id);
    context.database.close();
  });

  test("refuses to persist a value the manifest would reject", () => {
    const context = scenario();
    expect(() =>
      context.store.save({
        variantId: context.variant.id,
        decisions: { "page-margin": 999 },
        idempotencyKey: "bad",
      }),
    ).toThrow(TweakDecisionError);
    expect(context.store.listForVariant(context.variant.id)).toHaveLength(0);
    context.database.close();
  });

  test("restores decisions re-validated against the current manifest", () => {
    const context = scenario();
    const saved = context.store.save({
      variantId: context.variant.id,
      decisions: { accent: "#123456" },
      idempotencyKey: "restore",
    });

    const restored = context.store.restore(saved.id);
    expect(restored.decisions).toEqual({ accent: "#123456" });
    expect(restored.manifest.variantId).toBe(context.artifactPath);
    context.database.close();
  });

  test("reports when a regenerated manifest invalidates a saved decision", () => {
    const context = scenario();
    const saved = context.store.save({
      variantId: context.variant.id,
      decisions: { accent: "#123456" },
      idempotencyKey: "stale",
    });

    // The artifact was regenerated and no longer exposes that control.
    writeFileSync(
      resolve(context.cell, "workbench.json"),
      JSON.stringify(
        {
          version: 1,
          variantId: context.artifactPath,
          controls: [
            {
              id: "other",
              label: "Other",
              property: "--other",
              type: "color",
              default: "#000000",
            },
          ],
        },
        null,
        2,
      ),
    );

    // Reporting the mismatch beats applying a value the artifact cannot use.
    expect(() => context.store.restore(saved.id)).toThrow(TweakDecisionError);
    context.database.close();
  });
});

describe("agent-applied revisions", () => {
  test("renders each control type as a CSS declaration", () => {
    const manifest = workbenchTweakManifestSchema.parse({
      ...MANIFEST,
      variantId: "example",
    });
    const [accent, margin, motion] = manifest.controls;
    expect(declarationFor(accent!, "#ff0000")).toBe("--accent: #ff0000;");
    expect(declarationFor(margin!, 3)).toBe("--page-margin: 3rem;");
    expect(declarationFor(motion!, false)).toBe("--motion: 0;");
  });

  test("writes a new immutable artifact and leaves the parent untouched", async () => {
    const context = scenario();
    const parentBefore = readFileSync(
      resolve(context.cell, "assets", "site.css"),
      "utf8",
    );
    const saved = context.store.save({
      variantId: context.variant.id,
      decisions: { accent: "#ff8800", "page-margin": 3 },
      idempotencyKey: "apply",
    });

    const revision = await applyTweakRevision({
      database: context.database,
      studio: context.studio,
      runner: context.runner,
      generatedVariantsRoot: context.generated,
      workbenchRoot: resolve(import.meta.dir, "../.."),
      decisionSet: saved,
    });

    expect(revision.status).toBe("completed");
    expect(revision.sequence).toBe(1);
    // A sibling of the proof, not a child of it.
    expect(revision.artifactPath).toBe(`revisions/${context.variant.id}/r1`);
    // The revision is a separate artifact...
    expect(
      existsSync(
        resolve(context.generated, revision.artifactPath, "index.html"),
      ),
    ).toBe(true);
    // ...and the compared proof is byte-identical.
    expect(
      readFileSync(resolve(context.cell, "assets", "site.css"), "utf8"),
    ).toBe(parentBefore);
    expect(listRevisions(context.database, context.variant.id)).toHaveLength(1);
    context.database.close();
  });

  test("numbers successive revisions of the same proof", async () => {
    const context = scenario();
    for (const [index, accent] of ["#111111", "#222222"].entries()) {
      const saved = context.store.save({
        variantId: context.variant.id,
        decisions: { accent },
        idempotencyKey: `seq-${index}`,
      });
      await applyTweakRevision({
        database: context.database,
        studio: context.studio,
        runner: context.runner,
        generatedVariantsRoot: context.generated,
        workbenchRoot: resolve(import.meta.dir, "../.."),
        decisionSet: saved,
      });
    }

    const revisions = listRevisions(context.database, context.variant.id);
    expect(revisions.map((r) => r.sequence)).toEqual([1, 2]);
    expect(new Set(revisions.map((r) => r.artifactPath)).size).toBe(2);
    context.database.close();
  });

  test("records a failed revision instead of leaving it pending", async () => {
    const context = scenario(`#!/usr/bin/env bun
import { rmSync } from "node:fs";
rmSync("index.html");
process.stdout.write(JSON.stringify({type:"result", result:"broke it"}) + "\\n");
`);
    const saved = context.store.save({
      variantId: context.variant.id,
      decisions: { accent: "#ff8800" },
      idempotencyKey: "fails",
    });

    await expect(
      applyTweakRevision({
        database: context.database,
        studio: context.studio,
        runner: context.runner,
        generatedVariantsRoot: context.generated,
        workbenchRoot: resolve(import.meta.dir, "../.."),
        decisionSet: saved,
      }),
    ).rejects.toThrow();

    const [revision] = listRevisions(context.database, context.variant.id);
    expect(revision?.status).toBe("failed");
    expect(revision?.error).toBeTruthy();
    context.database.close();
  });

  test("refuses to apply an empty decision set", async () => {
    const context = scenario();
    const saved = context.store.save({
      variantId: context.variant.id,
      decisions: {},
      idempotencyKey: "empty",
    });

    await expect(
      applyTweakRevision({
        database: context.database,
        studio: context.studio,
        runner: context.runner,
        generatedVariantsRoot: context.generated,
        workbenchRoot: resolve(import.meta.dir, "../.."),
        decisionSet: saved,
      }),
    ).rejects.toThrow(TweakDecisionError);
    context.database.close();
  });
});
