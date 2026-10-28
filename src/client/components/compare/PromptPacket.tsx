import { useState } from "react";
import type { DesignBrief } from "../../library/types";
import { buildPromptPacket } from "./model";
import type {
  Comparison,
  ComparisonDirection,
  ComparisonEngine,
} from "./types";

export function PromptPacket({
  comparison,
  direction,
  engine,
  sourceBrief,
}: {
  readonly comparison: Comparison;
  readonly direction: ComparisonDirection;
  readonly engine: ComparisonEngine;
  readonly sourceBrief?: DesignBrief;
}) {
  const [status, setStatus] = useState("");
  const [generating, setGenerating] = useState(false);
  const label = engine === "impeccable" ? "Impeccable" : "Taste Skill";

  async function copy() {
    try {
      await navigator.clipboard.writeText(
        buildPromptPacket({ comparison, direction, engine, sourceBrief }),
      );
      setStatus(`${label} prompt packet copied.`);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `COPY_FAILED: ${error.message}`
          : "COPY_FAILED: Clipboard access was rejected.",
      );
    }
  }

  async function generate() {
    setGenerating(true);
    setStatus(`Running ${label} through local Claude Code…`);
    try {
      const response = await fetch(
        `/api/comparisons/${encodeURIComponent(comparison.id)}/directions/${encodeURIComponent(direction.id)}/engines/${engine}/generate`,
        { method: "POST" },
      );
      const body = (await response.json()) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(
          body.error?.message ?? `Generation failed (${response.status})`,
        );
      }
      setStatus(`${label} artifact generated and registered.`);
      window.location.reload();
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `GENERATION_FAILED: ${error.message}`
          : "GENERATION_FAILED: Local agent run failed.",
      );
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="prompt-packet">
      <button
        type="button"
        onClick={() => void generate()}
        disabled={generating}
      >
        {generating ? `Running ${label}…` : `Generate with ${label}`}
      </button>
      <button type="button" onClick={() => void copy()}>
        Copy prompt
      </button>
      <p role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
