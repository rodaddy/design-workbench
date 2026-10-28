import { useState, type FormEvent } from "react";
import type { LibraryRepository, LibrarySnapshot } from "../../library/types";
import { comparisonMessage } from "./repository";
import { sourceLabel } from "./model";
import type { Comparison, ComparisonRepository } from "./types";

interface CompareIndexProps {
  readonly comparisons: readonly Comparison[];
  readonly library: LibrarySnapshot;
  readonly libraryRepository: LibraryRepository;
  readonly comparisonRepository: ComparisonRepository;
  readonly refreshLibrary: () => Promise<void>;
  readonly navigate: (path: string) => void;
  readonly reload: () => Promise<void>;
}

export function CompareIndex({
  comparisons,
  library,
  libraryRepository,
  comparisonRepository,
  refreshLibrary,
  navigate,
  reload,
}: CompareIndexProps) {
  const [source, setSource] = useState("");
  const [directions, setDirections] = useState(3);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!source) {
      setError(
        "COMPARISON_SOURCE_REQUIRED: Choose a saved brief or Library entry.",
      );
      return;
    }

    setCreating(true);
    try {
      let briefId = source.slice(source.indexOf(":") + 1);
      if (source.startsWith("inspiration:")) {
        const brief =
          await libraryRepository.createBriefFromInspiration(briefId);
        briefId = brief.id;
        await refreshLibrary();
      }
      const comparison = await comparisonRepository.create({
        brief: briefId,
        directions,
      });
      await reload();
      navigate(`/compare/${encodeURIComponent(comparison.id)}`);
    } catch (caught) {
      setError(comparisonMessage(caught));
    } finally {
      setCreating(false);
    }
  }

  return (
    <main id="main-content" className="compare-surface compare-index">
      <header className="compare-heading">
        <div>
          <p className="compare-kicker">Comparison register</p>
          <h1>Compare</h1>
        </div>
        <p>
          Put one direction through both engines — Impeccable and Taste — on one
          shared viewport.
        </p>
      </header>

      <section
        className="comparison-new"
        aria-labelledby="comparison-new-title"
      >
        <div>
          <h2 id="comparison-new-title">Start a comparison</h2>
          <p>
            This creates the packet and ordered output slots. Generation stays
            in the operator workflow.
          </p>
        </div>
        <form onSubmit={create}>
          {error ? (
            <p className="compare-error" role="alert">
              {error}
            </p>
          ) : null}
          <label>
            Source
            <select
              required
              value={source}
              onChange={(event) => setSource(event.currentTarget.value)}
            >
              <option value="">Choose a brief or Library entry</option>
              <optgroup label="Saved briefs">
                {library.briefs.map((brief) => (
                  <option key={brief.id} value={`brief:${brief.id}`}>
                    {brief.title}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Library entries">
                {library.inspirations.map((item) => (
                  <option key={item.id} value={`inspiration:${item.id}`}>
                    {item.title}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label>
            Aesthetic directions
            <select
              value={directions}
              onChange={(event) =>
                setDirections(Number(event.currentTarget.value))
              }
            >
              {[1, 2, 3, 4, 5].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={creating || !source}>
            {creating ? "Creating packet…" : "Create comparison"}
          </button>
          {source ? (
            <p className="source-confirmation">
              Source selected:{" "}
              {sourceLabel(source, library.briefs, library.inspirations)}
            </p>
          ) : null}
        </form>
      </section>

      <section
        className="comparison-ledger"
        aria-labelledby="comparison-ledger-title"
      >
        <header>
          <h2 id="comparison-ledger-title">Comparison ledger</h2>
          <p>
            {comparisons.length}{" "}
            {comparisons.length === 1 ? "packet" : "packets"}
          </p>
        </header>
        {comparisons.length === 0 ? (
          <div className="compare-empty">
            <h3>No comparison packets yet</h3>
            <p>
              Start from a source above, or use{" "}
              <code>bun run comparison:new</code>. Fixture artifacts are
              included under <code>tests/fixtures/variants</code>.
            </p>
          </div>
        ) : (
          <ol>
            {comparisons.map((comparison) => {
              const registered = comparison.directions.reduce(
                (total, direction) => total + direction.variants.length,
                0,
              );
              const expected = comparison.directions.length * 2;
              return (
                <li key={comparison.id}>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`/compare/${encodeURIComponent(comparison.id)}`)
                    }
                  >
                    <span>
                      <strong>{comparison.title}</strong>
                      <small>
                        {comparison.directions.length} ordered directions
                      </small>
                    </span>
                    <span>
                      <small>Artifacts</small>
                      <strong>
                        {registered}/{expected}
                      </strong>
                    </span>
                    <span>
                      <small>Status</small>
                      <strong>{comparison.status}</strong>
                    </span>
                    <span aria-hidden="true">Open →</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </main>
  );
}
