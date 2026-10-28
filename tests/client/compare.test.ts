import { describe, expect, test } from "bun:test";
import {
  buildPromptPacket,
  calculateFrameScale,
  directionTabIndex,
  orderedDirections,
  parseCompareRoute,
  variantForEngine,
  viewports,
} from "../../src/client/components/compare/model";
import {
  probeVariantAvailability,
  VARIANT_IFRAME_SANDBOX,
  variantUrl,
} from "../../src/client/components/compare/isolation";
import {
  comparisonSchema,
  type Comparison,
} from "../../src/client/components/compare/types";

const comparison = comparisonSchema.parse({
  id: "comparison-fixture",
  slug: "fixture-proof",
  title: "Fixture Proof",
  sourceBriefId: "brief-fixture",
  status: "draft",
  createdAt: "2026-07-24T12:00:00.000Z",
  updatedAt: "2026-07-24T13:00:00.000Z",
  directions: [
    {
      id: "direction-b",
      position: 1,
      slug: "signal-paper",
      title: "Signal Paper",
      metadata: {},
      createdAt: "2026-07-24T12:00:00.000Z",
      variants: [],
    },
    {
      id: "direction-a",
      position: 0,
      slug: "index-nocturne",
      title: "Index Nocturne",
      metadata: {},
      createdAt: "2026-07-24T12:00:00.000Z",
      variants: [
        {
          id: "variant-impeccable",
          engine: "impeccable",
          artifactPath: "comparison-fixture/index-nocturne/impeccable",
          viewport: {},
          metadata: { source: "fixture" },
          createdAt: "2026-07-24T12:00:00.000Z",
          updatedAt: "2026-07-24T13:00:00.000Z",
        },
        {
          id: "variant-taste",
          engine: "taste",
          artifactPath: "comparison-fixture/index-nocturne/taste",
          viewport: {},
          metadata: { source: "fixture" },
          createdAt: "2026-07-24T12:00:00.000Z",
          updatedAt: "2026-07-24T13:00:00.000Z",
        },
      ],
    },
  ],
}) satisfies Comparison;

describe("comparison UI model", () => {
  test("routes the index and identifier workspace without a router dependency", () => {
    expect(parseCompareRoute("/compare")).toEqual({ page: "index" });
    expect(parseCompareRoute("/compare/fixture%20proof")).toEqual({
      page: "workspace",
      identifier: "fixture proof",
    });
  });

  test("keeps directions ordered and resolves both engines independently", () => {
    const directions = orderedDirections(comparison);
    expect(directions.map((direction) => direction.slug)).toEqual([
      "index-nocturne",
      "signal-paper",
    ]);
    expect(variantForEngine(directions[0]!, "impeccable")?.id).toBe(
      "variant-impeccable",
    );
    expect(variantForEngine(directions[0]!, "taste")?.id).toBe("variant-taste");
    expect(variantForEngine(directions[1]!, "taste")).toBeUndefined();
  });

  test("uses one named viewport model for both panels", () => {
    expect(Object.keys(viewports)).toEqual(["desktop", "tablet", "mobile"]);
    expect(viewports.desktop).toEqual({
      label: "Desktop",
      width: 1440,
      height: 900,
    });
    expect(calculateFrameScale(720, viewports.desktop.width)).toBe(0.5);
    expect(calculateFrameScale(1600, viewports.desktop.width)).toBe(1);
  });

  test("supports standard keyboard movement across direction tabs", () => {
    expect(directionTabIndex(0, "ArrowRight", 3)).toBe(1);
    expect(directionTabIndex(2, "ArrowRight", 3)).toBe(0);
    expect(directionTabIndex(0, "ArrowLeft", 3)).toBe(2);
    expect(directionTabIndex(1, "Home", 3)).toBe(0);
    expect(directionTabIndex(1, "End", 3)).toBe(2);
    expect(directionTabIndex(1, "Tab", 3)).toBeNull();
  });

  test("builds engine-specific prompt packets with exact output directories", () => {
    const direction = orderedDirections(comparison)[0]!;
    const impeccable = buildPromptPacket({
      comparison,
      direction,
      engine: "impeccable",
      sourceBrief: {
        id: "brief-fixture",
        title: "Fixture brief",
        markdown: "# Fixture brief",
        finalPrompt: "Build the fixture.",
        createdAt: "2026-07-24T12:00:00.000Z",
      },
    });
    const taste = buildPromptPacket({
      comparison,
      direction,
      engine: "taste",
    });

    expect(impeccable).toContain("RUN: Impeccable (impeccable)");
    expect(impeccable).toContain(
      "OUTPUT DIRECTORY: generated-variants/comparison-fixture/index-nocturne/impeccable",
    );
    expect(impeccable).toContain("Build the fixture.");
    expect(taste).toContain("RUN: Taste Skill (design-taste-frontend)");
    expect(taste).toContain("--engine taste");
  });

  test("constructs only separate-origin, contained variant URLs", () => {
    expect(VARIANT_IFRAME_SANDBOX).toBe("allow-scripts");
    expect(
      variantUrl(
        "comparison-fixture/index-nocturne/impeccable",
        "http://127.0.0.1:3001",
        "http://127.0.0.1:4173",
      ),
    ).toBe(
      "http://127.0.0.1:3001/comparison-fixture/index-nocturne/impeccable/index.html",
    );
    expect(() =>
      variantUrl(
        "comparison-fixture/index-nocturne/impeccable",
        "http://127.0.0.1:4173",
        "http://127.0.0.1:4173",
      ),
    ).toThrow("VARIANT_ORIGIN_NOT_ISOLATED");
    expect(() =>
      variantUrl(
        "../trusted",
        "http://127.0.0.1:3001",
        "http://127.0.0.1:4173",
      ),
    ).toThrow("VARIANT_ARTIFACT_PATH_INVALID");
  });

  test("probes the isolated artifact before treating an iframe load as ready", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    await probeVariantAvailability(
      "http://127.0.0.1:3001/comparison/index.html",
      async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(null, { status: 200 });
      },
    );
    expect(requests[0]?.url).toBe(
      "http://127.0.0.1:3001/comparison/index.html",
    );
    expect(requests[0]?.init).toMatchObject({
      method: "HEAD",
      mode: "cors",
      credentials: "omit",
    });
    await expect(
      probeVariantAvailability(
        "http://127.0.0.1:3001/missing/index.html",
        async () => new Response(null, { status: 404 }),
      ),
    ).rejects.toThrow("returned status 404");
  });
});
