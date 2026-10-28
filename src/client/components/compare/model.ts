import type { DesignBrief, Inspiration } from "../../library/types";
import type {
  Comparison,
  ComparisonDirection,
  ComparisonEngine,
  ComparisonVariant,
} from "./types";

export const viewports = {
  desktop: { label: "Desktop", width: 1440, height: 900 },
  tablet: { label: "Tablet", width: 820, height: 1180 },
  mobile: { label: "Mobile", width: 390, height: 844 },
} as const;

export type ViewportName = keyof typeof viewports;

export type CompareRoute =
  | { readonly page: "index" }
  | { readonly page: "workspace"; readonly identifier: string };

export function parseCompareRoute(pathname: string): CompareRoute {
  if (pathname === "/compare" || pathname === "/compare/")
    return { page: "index" };
  const match = pathname.match(/^\/compare\/([^/]+)\/?$/);
  if (!match?.[1]) return { page: "index" };
  try {
    return { page: "workspace", identifier: decodeURIComponent(match[1]) };
  } catch {
    return { page: "workspace", identifier: match[1] };
  }
}

export function orderedDirections(
  comparison: Comparison,
): readonly ComparisonDirection[] {
  return [...comparison.directions].sort(
    (left, right) =>
      left.position - right.position || left.id.localeCompare(right.id),
  );
}

export function variantForEngine(
  direction: ComparisonDirection,
  engine: ComparisonEngine,
): ComparisonVariant | undefined {
  return direction.variants.find((variant) => variant.engine === engine);
}

export function calculateFrameScale(
  availableWidth: number,
  viewportWidth: number,
): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 1;
  return Math.min(1, availableWidth / viewportWidth);
}

export function directionTabIndex(
  currentIndex: number,
  key: string,
  count: number,
): number | null {
  if (count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight" || key === "ArrowDown") {
    return (currentIndex + 1) % count;
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return (currentIndex - 1 + count) % count;
  }
  return null;
}

export function sourceLabel(
  value: string,
  briefs: readonly DesignBrief[],
  inspirations: readonly Inspiration[],
): string {
  if (value.startsWith("brief:")) {
    const id = value.slice("brief:".length);
    return briefs.find((brief) => brief.id === id)?.title ?? id;
  }
  const id = value.slice("inspiration:".length);
  return inspirations.find((item) => item.id === id)?.title ?? id;
}

interface PromptPacketInput {
  readonly comparison: Comparison;
  readonly direction: ComparisonDirection;
  readonly engine: ComparisonEngine;
  readonly sourceBrief?: DesignBrief;
}

export function buildPromptPacket({
  comparison,
  direction,
  engine,
  sourceBrief,
}: PromptPacketInput): string {
  const operator = engine === "impeccable" ? "Impeccable" : "Taste Skill";
  const skill =
    engine === "impeccable" ? "impeccable" : "design-taste-frontend";
  const outputDirectory = `generated-variants/${comparison.id}/${direction.slug}/${engine}`;
  const brief = sourceBrief?.finalPrompt.trim() || sourceBrief?.markdown.trim();
  const briefBlock =
    brief ||
    `Load saved brief ${comparison.sourceBriefId ?? "(missing source brief id)"}.`;
  return [
    `RUN: ${operator} (${skill})`,
    `COMPARISON: ${comparison.id}`,
    `DIRECTION: ${direction.title} (${direction.slug})`,
    `OUTPUT DIRECTORY: ${outputDirectory}`,
    "",
    "SOURCE BRIEF:",
    briefBlock,
    "",
    "DELIVERABLE:",
    "Write a complete static frontend artifact with index.html at the output directory above.",
    "Do not start a browser job or place model credentials in the artifact.",
    "",
    "REGISTER AFTER GENERATION:",
    `bun run variant:register --comparison ${comparison.id} --direction ${direction.slug} --engine ${engine} --path ${outputDirectory}`,
  ].join("\n");
}
