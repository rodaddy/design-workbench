import { variantForEngine, type ViewportName } from "./model";
import type { ComparisonDirection } from "./types";
import { VariantPanel } from "./VariantPanel";

function aestheticLabel(direction: ComparisonDirection): string {
  const value = direction.metadata.aestheticFamily;
  return typeof value === "string" && value.trim()
    ? value.trim()
    : direction.title;
}

/**
 * The wide-net contact sheet. Enqueueing and job status live in
 * GenerationJobPanel above it, so this component stays a pure proof board.
 */
export function AllDirectionsBoard({
  directions,
  viewport,
  variantOrigin,
  trustedOrigin,
  onSelect,
}: {
  readonly directions: readonly ComparisonDirection[];
  readonly viewport: ViewportName;
  readonly variantOrigin: string;
  readonly trustedOrigin: string;
  readonly onSelect: (directionId: string) => void;
}) {
  return (
    <section
      className="all-directions-board"
      aria-labelledby="all-directions-title"
    >
      <header className="all-directions-heading">
        <div>
          <p className="compare-kicker">Wide-net review</p>
          <h2 id="all-directions-title">All directions</h2>
        </div>
        <div className="all-directions-actions">
          <p>
            Scan every Impeccable and Taste proof together. Open a row to
            inspect it at full size.
          </p>
        </div>
      </header>
      <div className="all-directions-columns" aria-hidden="true">
        <span>Impeccable</span>
        <span>Taste Skill</span>
      </div>
      <ol>
        {directions.map((direction, index) => (
          <li key={direction.id}>
            <header>
              <button type="button" onClick={() => onSelect(direction.id)}>
                <span>V{index + 1}</span>
                <strong>{aestheticLabel(direction)}</strong>
                <small>Open paired proof →</small>
              </button>
            </header>
            <div className="all-directions-pair">
              <VariantPanel
                engine="impeccable"
                directionTitle={direction.title}
                variant={variantForEngine(direction, "impeccable")}
                viewport={viewport}
                variantOrigin={variantOrigin}
                trustedOrigin={trustedOrigin}
                display="overview"
              />
              <VariantPanel
                engine="taste"
                directionTitle={direction.title}
                variant={variantForEngine(direction, "taste")}
                viewport={viewport}
                variantOrigin={variantOrigin}
                trustedOrigin={trustedOrigin}
                display="overview"
              />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
