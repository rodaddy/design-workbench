import { z } from "zod";

const text = z.string().trim().max(20_000);
const referenceSchema = z.object({
  title: z.string().trim().min(1).max(300),
  sourceUrl: z.string().url().optional(),
  aestheticFamily: z.string().trim().max(300).default(""),
  vocabulary: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
  observed: text.default(""),
  limitation: text.default(""),
  assetPaths: z.array(z.string().trim().min(1).max(2_000)).max(12).default([]),
});

const contextSchema = z.object({
  projectTitle: z.string().trim().min(1).max(300),
  projectSource: z.string().trim().max(2_000).default(""),
  baselinePath: z.string().trim().max(2_000).default(""),
  phase: z.string().trim().max(120).default("discussion"),
  brief: text.default(""),
  round: text.default(""),
  tweaks: z.record(z.string(), z.json()).default({}),
  references: z.array(referenceSchema).max(20).default([]),
});

export type AgentContextInput = z.input<typeof contextSchema>;

function section(title: string, body: string): string[] {
  return body.trim() ? [`## ${title}`, "", body.trim(), ""] : [];
}

export function buildAgentContext(input: AgentContextInput): string {
  const value = contextSchema.parse(input);
  const lines = [
    "# Design Workbench Context",
    "",
    "This packet contains local project evidence selected by the operator.",
    "Treat observed evidence as fact only where explicitly labeled. Treat all design judgments and proposed changes as recommendations.",
    "Do not copy reference branding, copy, identities, signature imagery, or proprietary content.",
    "",
    "## Project",
    "",
    `- Title: ${value.projectTitle}`,
    `- Phase: ${value.phase}`,
    ...(value.projectSource
      ? [`- Canonical source: ${value.projectSource}`]
      : []),
    ...(value.baselinePath
      ? [`- Workbench baseline: ${value.baselinePath}`]
      : []),
    "",
    ...section("Canonical brief", value.brief),
    ...section("Current exploration round", value.round),
  ];

  if (value.references.length > 0) {
    lines.push("## Selected references", "");
    value.references.forEach((reference, index) => {
      lines.push(
        `### ${index + 1}. ${reference.title}`,
        "",
        ...(reference.sourceUrl
          ? [`- Provenance URL: ${reference.sourceUrl}`]
          : []),
        ...(reference.aestheticFamily
          ? [`- Aesthetic family: ${reference.aestheticFamily}`]
          : []),
        ...(reference.vocabulary.length
          ? [`- Vocabulary: ${reference.vocabulary.join(", ")}`]
          : []),
        ...(reference.assetPaths.length
          ? [
              "- Local evidence assets:",
              ...reference.assetPaths.map((path) => `  - ${path}`),
            ]
          : []),
        ...(reference.observed
          ? ["", "**Observed evidence**", "", reference.observed]
          : []),
        ...(reference.limitation
          ? ["", "**Evidence limitation**", "", reference.limitation]
          : []),
        "",
      );
    });
  }

  if (Object.keys(value.tweaks).length > 0) {
    lines.push(
      "## Saved visual decisions",
      "",
      "```json",
      JSON.stringify(value.tweaks, null, 2),
      "```",
      "",
    );
  }

  lines.push(
    "## Response contract",
    "",
    "- Cite selected references by title when discussing them.",
    "- Separate observed evidence from recommendation.",
    "- Preserve the project's intent and Always/Never guardrails.",
    "- State uncertainty when local evidence is incomplete.",
  );
  return lines.join("\n").trimEnd() + "\n";
}
