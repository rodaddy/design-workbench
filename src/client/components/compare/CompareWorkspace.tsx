import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { DesignBrief } from "../../library/types";
import {
  HttpStudioRepository,
  type StudioRepository,
} from "../../studio/repository";
import type { GenerationJob } from "../../studio/types";
import { GenerationJobPanel } from "./GenerationJobPanel";
import {
  directionTabIndex,
  orderedDirections,
  variantForEngine,
  viewports,
  type ViewportName,
} from "./model";
import { AllDirectionsBoard } from "./AllDirectionsBoard";
import { PromptPacket } from "./PromptPacket";
import type { Comparison } from "./types";
import { VariantPanel } from "./VariantPanel";

/*
THESIS: Two isolated proof frames share one direction and one viewport rail; it refuses independent preview cards and route mastheads.
OWN-WORLD: Dark layered panels, hairline rules, mono proof registers, and one warm amber signal — the same console as the rest of the app.
STORY: Pick an ordered direction (ALL 5 or V1…V5), lock one viewport, inspect Impeccable vs Taste, then refine or copy the exact packet.
FIRST VIEWPORT: A compact tab strip and single viewport rail sit above equal Impeccable/Taste frames with status labels at the edge.
FORM: Operate mode, studio-console register inherited from the shell; the approved brief pins the working staging, no generated seed.
*/

export function CompareWorkspace({
  comparison,
  sourceBrief,
  variantOrigin,
  trustedOrigin,
  navigate,
  studioRepository = new HttpStudioRepository(),
}: {
  readonly comparison: Comparison;
  readonly sourceBrief?: DesignBrief;
  readonly variantOrigin: string;
  readonly trustedOrigin: string;
  readonly navigate: (path: string) => void;
  readonly studioRepository?: StudioRepository;
}) {
  const directions = useMemo(() => orderedDirections(comparison), [comparison]);
  const [selectedId, setSelectedId] = useState(
    directions.length > 1 ? "all" : (directions[0]?.id ?? ""),
  );
  const [viewport, setViewport] = useState<ViewportName>("desktop");
  const [jobs, setJobs] = useState<readonly GenerationJob[]>([]);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [generationStatus, setGenerationStatus] = useState("");
  const [refining, setRefining] = useState(false);
  const [refinementStatus, setRefinementStatus] = useState("");
  const directionTabs = useRef(new Map<string, HTMLButtonElement>());
  const tabIds = useMemo(
    () => ["all", ...directions.map((item) => item.id)],
    [directions],
  );
  const direction = directions.find((item) => item.id === selectedId);
  const fallbackDirection = direction ?? directions[0];

  if (!fallbackDirection) {
    return (
      <main id="main-content" className="compare-surface">
        <div className="compare-failure" role="alert">
          <h1>Comparison has no directions</h1>
          <p>
            The persisted comparison violates the one-to-five direction
            contract.
          </p>
          <button type="button" onClick={() => navigate("/compare")}>
            Return to Compare
          </button>
        </div>
      </main>
    );
  }

  const activeDirection = direction ?? fallbackDirection;
  const impeccable = variantForEngine(activeDirection, "impeccable");
  const taste = variantForEngine(activeDirection, "taste");

  function navigateDirectionTabs(
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) {
    const targetIndex = directionTabIndex(
      currentIndex,
      event.key,
      tabIds.length,
    );
    if (targetIndex === null) return;
    const targetId = tabIds[targetIndex];
    if (!targetId) return;
    event.preventDefault();
    setSelectedId(targetId);
    directionTabs.current.get(targetId)?.focus();
  }

  // Generation runs out of band now, so the workspace polls job state instead
  // of holding one long request per artifact. Polling stops as soon as nothing
  // is queued or running, so an idle comparison costs nothing.
  const hasLiveJobs = jobs.some(
    (job) => job.status === "queued" || job.status === "running",
  );

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const next = await studioRepository.listJobs(comparison.id);
        if (!cancelled) setJobs(next);
      } catch {
        // A failed poll is not worth interrupting the operator; the next tick
        // recovers, and any real failure is already recorded on the job row.
      }
    }
    void refresh();
    if (!hasLiveJobs) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [comparison.id, hasLiveJobs, studioRepository]);

  // When the last job settles, registered proofs exist that the loaded
  // comparison snapshot does not know about yet.
  const settledCount = jobs.filter(
    (job) => job.status === "completed" || job.status === "cancelled",
  ).length;
  const previousSettled = useRef(settledCount);
  useEffect(() => {
    if (settledCount > previousSettled.current && !hasLiveJobs) {
      setGenerationStatus("Generation finished. Reload to view new proofs.");
    }
    previousSettled.current = settledCount;
  }, [settledCount, hasLiveJobs]);

  async function generateAllMissing() {
    setGeneratingAll(true);
    setGenerationStatus("");
    try {
      const missing = directions.flatMap((item) =>
        (["impeccable", "taste"] as const).filter(
          (engine) => !variantForEngine(item, engine),
        ),
      );
      if (missing.length === 0) {
        setGenerationStatus("All ten proofs are already registered.");
        return;
      }
      setJobs(await studioRepository.enqueueMissingProofs(comparison.id));
      setGenerationStatus(`Queued ${missing.length} proof generations.`);
    } catch (error) {
      setGenerationStatus(
        error instanceof Error
          ? `GENERATION_FAILED: ${error.message}`
          : "GENERATION_FAILED",
      );
    } finally {
      setGeneratingAll(false);
    }
  }

  async function cancelJob(jobId: string) {
    try {
      await studioRepository.cancelJob(jobId);
      setJobs(await studioRepository.listJobs(comparison.id));
    } catch (error) {
      setGenerationStatus(
        error instanceof Error ? error.message : "Cancellation failed",
      );
    }
  }

  async function createRefinement() {
    setRefining(true);
    setRefinementStatus("");
    try {
      await studioRepository.createRefinement(
        comparison.id,
        activeDirection.id,
      );
      navigate("/studio");
    } catch (error) {
      setRefinementStatus(
        error instanceof Error ? error.message : "Refinement creation failed",
      );
    } finally {
      setRefining(false);
    }
  }

  return (
    <main id="main-content" className="compare-surface compare-workspace">
      <div className="comparison-controls">
        <div className="compare-register-meta">
          <button
            type="button"
            className="back-link"
            aria-label="Return to comparison ledger"
            onClick={() => navigate("/compare")}
          >
            ←
          </button>
          <div>
            <h1>{comparison.title}</h1>
            <p>
              {sourceBrief?.title ??
                `Source brief ${comparison.sourceBriefId ?? "not attached"}`}
            </p>
          </div>
        </div>
        <div
          className="direction-tabs"
          role="tablist"
          aria-label="Aesthetic directions"
        >
          <button
            ref={(element) => {
              if (element) directionTabs.current.set("all", element);
              else directionTabs.current.delete("all");
            }}
            id="direction-tab-all"
            type="button"
            role="tab"
            aria-selected={selectedId === "all"}
            aria-controls="all-directions-proof"
            tabIndex={selectedId === "all" ? 0 : -1}
            onClick={() => setSelectedId("all")}
            onKeyDown={(event) => navigateDirectionTabs(event, 0)}
          >
            <span>10</span>
            All 5
          </button>
          {directions.map((item, index) => (
            <button
              key={item.id}
              ref={(element) => {
                if (element) directionTabs.current.set(item.id, element);
                else directionTabs.current.delete(item.id);
              }}
              id={`direction-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={item.id === selectedId}
              aria-controls="direction-proof"
              tabIndex={item.id === selectedId ? 0 : -1}
              onClick={() => setSelectedId(item.id)}
              onKeyDown={(event) => navigateDirectionTabs(event, index + 1)}
            >
              <span>V{item.position + 1}</span>
              {typeof item.metadata.aestheticFamily === "string" &&
              item.metadata.aestheticFamily.trim()
                ? item.metadata.aestheticFamily
                : item.title}
            </button>
          ))}
        </div>
        <fieldset className="viewport-selector">
          <legend>Shared viewport</legend>
          {Object.entries(viewports).map(([name, dimensions]) => (
            <label key={name}>
              <input
                type="radio"
                name="viewport"
                value={name}
                checked={viewport === name}
                onChange={() => setViewport(name as ViewportName)}
              />
              <span>{dimensions.label}</span>
              <small>
                {dimensions.width} × {dimensions.height}
              </small>
            </label>
          ))}
        </fieldset>
      </div>

      {selectedId === "all" ? (
        <div
          id="all-directions-proof"
          role="tabpanel"
          aria-labelledby="direction-tab-all"
        >
          <GenerationJobPanel
            jobs={jobs}
            directions={directions}
            onEnqueue={() => void generateAllMissing()}
            onCancel={(jobId) => void cancelJob(jobId)}
            busy={generatingAll || hasLiveJobs}
            status={generationStatus}
          />
          <AllDirectionsBoard
            directions={directions}
            viewport={viewport}
            variantOrigin={variantOrigin}
            trustedOrigin={trustedOrigin}
            onSelect={setSelectedId}
          />
        </div>
      ) : (
        <div
          id="direction-proof"
          role="tabpanel"
          aria-labelledby={`direction-tab-${activeDirection.id}`}
        >
          <div className="engine-column-strip" aria-hidden="true">
            <span>
              Impeccable <small>{activeDirection.title}</small>
            </span>
            <span>
              Taste Skill <small>{activeDirection.title}</small>
            </span>
          </div>
          <div className="direction-refinement-action">
            <button
              type="button"
              disabled={refining}
              onClick={() => void createRefinement()}
            >
              Choose direction / Generate 3 refinements
            </button>
            {refinementStatus ? <p role="alert">{refinementStatus}</p> : null}
          </div>
          <section className="proof-pair">
            <div>
              <VariantPanel
                engine="impeccable"
                directionTitle={activeDirection.title}
                variant={impeccable}
                viewport={viewport}
                variantOrigin={variantOrigin}
                trustedOrigin={trustedOrigin}
              />
              <PromptPacket
                comparison={comparison}
                direction={activeDirection}
                engine="impeccable"
                sourceBrief={sourceBrief}
              />
            </div>
            <div>
              <VariantPanel
                engine="taste"
                directionTitle={activeDirection.title}
                variant={taste}
                viewport={viewport}
                variantOrigin={variantOrigin}
                trustedOrigin={trustedOrigin}
              />
              <PromptPacket
                comparison={comparison}
                direction={activeDirection}
                engine="taste"
                sourceBrief={sourceBrief}
              />
            </div>
          </section>
        </div>
      )}

      <details className="source-brief">
        <summary>Source brief and direction metadata</summary>
        <div>
          <section>
            <h2>Source brief</h2>
            <pre>
              {sourceBrief?.markdown ??
                "The source brief is not present in the loaded Library snapshot."}
            </pre>
          </section>
          <section>
            <h2>Direction metadata</h2>
            <pre>{JSON.stringify(activeDirection.metadata, null, 2)}</pre>
          </section>
        </div>
      </details>
    </main>
  );
}
