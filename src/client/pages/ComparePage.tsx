import { useCallback, useEffect, useRef, useState } from "react";
import { CompareIndex } from "../components/compare/CompareIndex";
import { CompareWorkspace } from "../components/compare/CompareWorkspace";
import { parseCompareRoute } from "../components/compare/model";
import { comparisonMessage } from "../components/compare/repository";
import type {
  Comparison,
  ComparisonRepository,
} from "../components/compare/types";
import type { LibraryRepository, LibrarySnapshot } from "../library/types";
import {
  HttpStudioRepository,
  type StudioRepository,
} from "../studio/repository";
import "../components/compare/compare.css";

export function ComparePage({
  pathname,
  library,
  libraryRepository,
  comparisonRepository,
  refreshLibrary,
  variantOrigin,
  trustedOrigin,
  navigate,
  studioRepository = new HttpStudioRepository(),
}: {
  readonly pathname: string;
  readonly library: LibrarySnapshot;
  readonly libraryRepository: LibraryRepository;
  readonly comparisonRepository: ComparisonRepository;
  readonly refreshLibrary: () => Promise<void>;
  readonly variantOrigin: string;
  readonly trustedOrigin: string;
  readonly navigate: (path: string) => void;
  readonly studioRepository?: StudioRepository;
}) {
  const route = parseCompareRoute(pathname);
  const [comparisons, setComparisons] = useState<readonly Comparison[]>([]);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestGeneration = useRef(0);

  const reload = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError("");
    try {
      const listed = await comparisonRepository.list();
      if (generation !== requestGeneration.current) return;
      setComparisons(listed);
      if (route.page === "workspace") {
        const selected =
          listed.find(
            (item) =>
              item.id === route.identifier || item.slug === route.identifier,
          ) ?? (await comparisonRepository.get(route.identifier));
        if (generation !== requestGeneration.current) return;
        setComparison(selected);
      } else {
        setComparison(null);
      }
    } catch (caught) {
      if (generation !== requestGeneration.current) return;
      setError(comparisonMessage(caught));
      setComparison(null);
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [
    comparisonRepository,
    route.page,
    route.page === "workspace" ? route.identifier : "",
  ]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) {
    return (
      <main id="main-content" className="compare-surface compare-loading">
        <p role="status">Loading comparison register…</p>
      </main>
    );
  }

  if (error) {
    return (
      <main id="main-content" className="compare-surface">
        <div className="compare-failure">
          <p className="compare-kicker">Comparison contract unavailable</p>
          <h1>Compare could not load</h1>
          <p role="alert">{error}</p>
          <button type="button" onClick={() => void reload()}>
            Retry comparison API
          </button>
        </div>
      </main>
    );
  }

  if (route.page === "workspace" && comparison) {
    const sourceBrief = library.briefs.find(
      (brief) => brief.id === comparison.sourceBriefId,
    );
    return (
      <CompareWorkspace
        comparison={comparison}
        sourceBrief={sourceBrief}
        variantOrigin={variantOrigin}
        trustedOrigin={trustedOrigin}
        navigate={navigate}
        studioRepository={studioRepository}
      />
    );
  }

  return (
    <CompareIndex
      comparisons={comparisons}
      library={library}
      libraryRepository={libraryRepository}
      comparisonRepository={comparisonRepository}
      refreshLibrary={refreshLibrary}
      navigate={navigate}
      reload={reload}
    />
  );
}
