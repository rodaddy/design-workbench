import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createComparison } from "../../src/server/comparisons";
import { migrateDatabase } from "../../src/server/database";
import {
  buildHandoffPacket,
  HandoffError,
  renderHandoffMarkdown,
} from "../../src/server/handoff";
import { StudioProjectStore } from "../../src/server/projects";
import { StudioService } from "../../src/server/studio";
import { TweakDecisionStore } from "../../src/server/tweak-decisions";
import { registerVariant } from "../../src/server/variants";

/**
 * The handoff packet is the only artifact that leaves the workbench, so what
 * it asserts must be true: that it summarizes real decisions, and that it has
 * applied none of them.
 */

const root = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/handoff-tests",
  `${process.pid}-${Date.now()}`,
);
const archive = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/handoff-tests/_archive",
);

const brief = `# Handoff proof

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
Prove the handoff packet.

## Audience
Operators.

## Primary action
Export decisions.

## Always
- Preserve real content

## Never
- Modify canonical source

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

function scenario() {
  const run = resolve(root, crypto.randomUUID());
  const allowed = resolve(run, "allowed");
  const source = resolve(allowed, "site");
  const runtime = resolve(run, "runtime");
  const generated = resolve(run, "generated");
  const briefPath = resolve(run, "brief.md");
  mkdirSync(source, { recursive: true });
  mkdirSync(generated, { recursive: true });
  writeFileSync(resolve(source, "index.html"), "<h1>Owned baseline</h1>\n");
  writeFileSync(briefPath, brief);

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
  mkdirSync(cell, { recursive: true });
  writeFileSync(resolve(cell, "index.html"), "<h1>Proof</h1>\n");
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
    project,
    variant,
    generated,
    source,
    artifactPath,
    store: new TweakDecisionStore(database, generated),
  };
}

function packetFor(context: ReturnType<typeof scenario>) {
  return buildHandoffPacket({
    database: context.database,
    generatedVariantsRoot: context.generated,
    projectId: context.project.id,
    generatedAt: "2026-07-24T18:00:00.000Z",
  });
}

describe("handoff packet", () => {
  test("summarizes the brief, project, rounds, and produced artifacts", () => {
    const context = scenario();
    const packet = packetFor(context);

    expect(packet.version).toBe(1);
    expect(packet.project.slug).toBe("owned-site");
    // The canonical path is recorded so a reviewer can confirm which site the
    // work was derived from.
    expect(packet.project.canonicalSourcePath).toBe(context.source);
    expect(packet.brief?.title.length).toBeGreaterThan(0);
    expect(packet.rounds).toHaveLength(1);
    expect(packet.rounds[0]?.stage).toBe("wide-net");
    expect(packet.artifacts).toHaveLength(1);
    expect(packet.artifacts[0]?.artifactPath).toBe(context.artifactPath);
    expect(packet.artifacts[0]?.tweakControls).toBe(1);
  });

  test("includes saved tweak decisions with their values", () => {
    const context = scenario();
    context.store.save({
      variantId: context.variant.id,
      label: "Warmer accent",
      decisions: { accent: "#aa3311" },
      idempotencyKey: "decision-one",
    });

    const packet = packetFor(context);
    expect(packet.decisions).toHaveLength(1);
    expect(packet.decisions[0]?.label).toBe("Warmer accent");
    expect(packet.decisions[0]?.decisions).toEqual({ accent: "#aa3311" });
  });

  test("states what it has deliberately not done", () => {
    const packet = packetFor(scenario());
    const scope = packet.notApplied.join(" ");
    expect(scope).toContain("canonical source");
    expect(scope).toContain("deployed");
    // A packet that quietly applied its own contents would make an export
    // indistinguishable from a release.
    expect(packet.notApplied.length).toBeGreaterThan(0);
  });

  test("distinguishes a proof with no manifest from one offering no controls", () => {
    const context = scenario();
    // A second proof with no workbench.json at all.
    const bare = `${context.artifactPath.replace("impeccable", "taste")}`;
    const cell = resolve(context.generated, bare);
    mkdirSync(cell, { recursive: true });
    writeFileSync(resolve(cell, "index.html"), "<h1>No manifest</h1>\n");
    const direction = context.database
      .query<{ id: string }, []>("SELECT id FROM aesthetic_directions LIMIT 1")
      .get();
    registerVariant(context.database, {
      comparison: context.database
        .query<{ comparison_id: string }, []>(
          "SELECT comparison_id FROM aesthetic_directions LIMIT 1",
        )
        .get()!.comparison_id,
      direction: direction?.id ?? "",
      engine: "taste",
      path: cell,
      generatedRoot: context.generated,
    });

    const packet = packetFor(context);
    const missing = packet.artifacts.find((a) => a.engine === "taste");
    expect(missing?.tweakControls).toBeNull();
  });

  test("rejects an unknown project rather than exporting an empty packet", () => {
    const context = scenario();
    let caught: unknown;
    try {
      buildHandoffPacket({
        database: context.database,
        generatedVariantsRoot: context.generated,
        projectId: "does-not-exist",
        generatedAt: "2026-07-24T18:00:00.000Z",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HandoffError);
    expect((caught as HandoffError).code).toBe("HANDOFF_NOT_FOUND");
  });

  test("renders markdown a reviewer can read", () => {
    const context = scenario();
    context.store.save({
      variantId: context.variant.id,
      label: "Warmer accent",
      decisions: { accent: "#aa3311" },
      idempotencyKey: "decision-one",
    });

    const markdown = renderHandoffMarkdown(packetFor(context));
    expect(markdown).toContain("# Handoff packet — Owned Site");
    expect(markdown).toContain("## Scope");
    expect(markdown).toContain("canonical source");
    expect(markdown).toContain("Warmer accent");
    expect(markdown).toContain("`accent`: #aa3311");
    expect(markdown.endsWith("\n")).toBe(true);
  });
});
