import { describe, expect, test } from "bun:test";
import { buildAgentContext } from "../../src/server/agent-context";

describe("local agent context packet", () => {
  test("grounds the conversation in selected evidence and labels recommendations", () => {
    const packet = buildAgentContext({
      projectTitle: "Rico Rojas",
      projectSource: "/local/rico-rojas",
      baselinePath: "projects/example/baselines/1",
      phase: "wide-net",
      brief:
        "Always preserve authorship. Never use a generic portfolio template.",
      round: "Create five distinct aesthetic families.",
      tweaks: { "heading-scale": 1.2 },
      references: [
        {
          title: "Quiet Ledger",
          sourceUrl: "https://example.com/quiet-ledger",
          aestheticFamily: "Vast Quiet",
          vocabulary: ["measured", "cinematic"],
          observed: "A quiet hero leads into a fixed editorial index.",
          limitation: "Only the supplied screenshot was observed.",
          assetPaths: ["captures/quiet-ledger.webp"],
        },
      ],
    });

    expect(packet).toContain("# Design Workbench Context");
    expect(packet).toContain("Quiet Ledger");
    expect(packet).toContain("**Observed evidence**");
    expect(packet).toContain("**Evidence limitation**");
    expect(packet).toContain("Treat all design judgments");
    expect(packet).toContain('"heading-scale": 1.2');
    expect(packet).toContain("Cite selected references by title");
  });

  test("rejects oversized reference sets", () => {
    expect(() =>
      buildAgentContext({
        projectTitle: "Project",
        references: Array.from({ length: 21 }, (_, index) => ({
          title: `Reference ${index}`,
        })),
      }),
    ).toThrow();
  });
});
