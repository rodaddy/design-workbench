import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ComparisonRepository } from "../components/compare/types";
import type { LibrarySnapshot } from "../library/types";
import { AgentPanel } from "../studio/AgentPanel";
import {
  HttpStudioRepository,
  type CreateStudioProjectInput,
  type StudioRepository,
} from "../studio/repository";
import type {
  StudioProject,
  StudioRound,
  StudioSession,
} from "../studio/types";
import "../studio/studio.css";

const defaultWideNetFamilies = [
  "Print Tech / Paper",
  "Data as Texture",
  "Vast Quiet / Cinematic",
  "Dither Mono",
  "Classical Remix",
] as const;

const localSites = [
  {
    slug: "rtech-consulting",
    title: "rTech Consulting",
    sourcePath: "/path/to/rtech-consulting/site/rtech-consulting",
  },
  {
    slug: "rico-rojas",
    title: "Rico Rojas",
    sourcePath: "/path/to/rtech-consulting/site/rico-rojas",
  },
] as const;

export function StudioPage({
  library,
  comparisonRepository,
  navigate,
  repository = new HttpStudioRepository(),
}: {
  readonly library: LibrarySnapshot;
  readonly comparisonRepository: ComparisonRepository;
  readonly navigate: (path: string) => void;
  readonly repository?: StudioRepository;
}) {
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [rounds, setRounds] = useState<StudioRound[]>([]);
  const [selectedRoundId, setSelectedRoundId] = useState("");
  const [selectedBriefId, setSelectedBriefId] = useState("");
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>(
    [],
  );
  const [session, setSession] = useState<StudioSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [manual, setManual] = useState({ slug: "", title: "", sourcePath: "" });

  const project = projects.find((item) => item.id === selectedProjectId);
  const round =
    rounds.find((item) => item.id === selectedRoundId) ?? rounds.at(-1);
  const brief = library.briefs.find((item) => item.id === selectedBriefId);
  const references = useMemo(
    () =>
      library.inspirations.filter((item) =>
        selectedReferenceIds.includes(item.id),
      ),
    [library.inspirations, selectedReferenceIds],
  );

  async function reloadProjects(preferredId?: string) {
    const next = await repository.listProjects();
    setProjects(next);
    const id = preferredId ?? selectedProjectId ?? next[0]?.id ?? "";
    setSelectedProjectId(
      next.some((item) => item.id === id) ? id : (next[0]?.id ?? ""),
    );
  }

  useEffect(() => {
    void reloadProjects()
      .catch((caught) =>
        setError(
          caught instanceof Error ? caught.message : "Studio failed to load",
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setSession(null);
    if (!selectedProjectId) {
      setRounds([]);
      return;
    }
    void repository
      .listRounds(selectedProjectId)
      .then((next) => {
        setRounds(next);
        setSelectedRoundId(next.at(-1)?.id ?? "");
      })
      .catch((caught) =>
        setError(
          caught instanceof Error ? caught.message : "Rounds failed to load",
        ),
      );
  }, [repository, selectedProjectId]);

  useEffect(() => {
    if (selectedBriefId) return;
    const fallback = library.briefs.at(-1)?.id ?? library.briefs[0]?.id ?? "";
    if (fallback) setSelectedBriefId(fallback);
  }, [library.briefs, selectedBriefId]);

  async function createProject(input: CreateStudioProjectInput) {
    setWorking(true);
    setError("");
    try {
      const created = await repository.createProject(input);
      await reloadProjects(created.id);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Project creation failed",
      );
    } finally {
      setWorking(false);
    }
  }

  async function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await createProject({ ...manual, idempotencyKey: crypto.randomUUID() });
  }

  async function createWideNet() {
    if (!project || !brief) {
      setError(
        "Choose a project and canonical brief before creating five directions.",
      );
      return;
    }
    setWorking(true);
    setError("");
    try {
      const selectedFamilies = references
        .map((item) => item.aestheticFamily.trim())
        .filter(
          (family, index, all) => family && all.indexOf(family) === index,
        );
      const families = [...selectedFamilies];
      for (const fallback of defaultWideNetFamilies) {
        if (families.length >= 5) break;
        if (!families.includes(fallback)) families.push(fallback);
      }
      const directionConfiguration = families.slice(0, 5).map((family) => ({
        title: family,
        aestheticFamily: family,
        referenceIds: references
          .filter((item) => item.aestheticFamily.trim() === family)
          .map((item) => item.id),
      }));
      const comparison = await comparisonRepository.create({
        brief: brief.id,
        directions: 5,
      });
      const createdRound = await repository.createRound(project.id, {
        stage: "wide-net",
        prompt:
          "Create five clearly distinct aesthetic directions from the selected references. Use Impeccable on the left and Taste Skill on the right for every direction.",
        payload: {
          optionCount: 5,
          engines: ["impeccable", "taste"],
          referenceIds: selectedReferenceIds,
          briefId: brief.id,
        },
        comparisonId: comparison.id,
        parentRoundId: null,
        idempotencyKey: crypto.randomUUID(),
      });
      await repository.configureDirections(
        project.id,
        createdRound.id,
        directionConfiguration,
      );
      setRounds((current) => [...current, createdRound]);
      navigate(`/compare/${encodeURIComponent(comparison.id)}`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Wide-net round creation failed",
      );
    } finally {
      setWorking(false);
    }
  }

  function toggleReference(id: string) {
    setSelectedReferenceIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  }

  if (loading) {
    return (
      <main id="main-content" className="studio-surface">
        <p role="status">Loading Studio…</p>
      </main>
    );
  }

  const setup = (
    <details className="studio-setup" open={projects.length === 0}>
      <summary>Add or register a local project</summary>
      <div>
        <div className="studio-project-actions">
          {localSites.map((site) => (
            <button
              key={site.slug}
              type="button"
              disabled={
                working || projects.some((item) => item.slug === site.slug)
              }
              onClick={() =>
                void createProject({
                  ...site,
                  idempotencyKey: `local-${site.slug}`,
                })
              }
            >
              {projects.some((item) => item.slug === site.slug)
                ? `${site.title} added`
                : `Add ${site.title}`}
            </button>
          ))}
        </div>
        <form onSubmit={submitManual} className="studio-project-form">
          <label>
            Title
            <input
              required
              value={manual.title}
              onChange={(event) =>
                setManual({ ...manual, title: event.currentTarget.value })
              }
            />
          </label>
          <label>
            Slug
            <input
              required
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              value={manual.slug}
              onChange={(event) =>
                setManual({ ...manual, slug: event.currentTarget.value })
              }
            />
          </label>
          <label>
            Local source path
            <input
              required
              value={manual.sourcePath}
              onChange={(event) =>
                setManual({ ...manual, sourcePath: event.currentTarget.value })
              }
            />
          </label>
          <button type="submit" disabled={working}>
            Add local project
          </button>
        </form>
      </div>
    </details>
  );

  return (
    <main id="main-content" className="studio-surface">
      <header className="studio-heading">
        <h1>Studio</h1>
        {projects.length ? (
          <div
            className="studio-project-tabs"
            role="tablist"
            aria-label="Studio projects"
          >
            {projects.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={item.id === selectedProjectId}
                onClick={() => setSelectedProjectId(item.id)}
              >
                <span>{item.title}</span>
                <small>
                  {item.baselines.length} baseline{" "}
                  {item.baselines.length === 1 ? "revision" : "revisions"}
                </small>
              </button>
            ))}
          </div>
        ) : null}
      </header>

      {error ? (
        <p className="studio-error" role="alert">
          {error}
        </p>
      ) : null}

      {project ? (
        <div className="studio-workbench">
          <section
            className="studio-evidence"
            aria-labelledby="studio-evidence-title"
          >
            {setup}
            <header>
              <h2 id="studio-evidence-title">Design evidence</h2>
              <button
                type="button"
                disabled={working}
                onClick={() =>
                  void repository
                    .createBaseline(project.id)
                    .then(() => reloadProjects(project.id))
                    .catch((caught) =>
                      setError(
                        caught instanceof Error
                          ? caught.message
                          : "Baseline failed",
                      ),
                    )
                }
              >
                Snapshot current source
              </button>
            </header>
            <dl className="studio-project-facts">
              <div>
                <dt>Source</dt>
                <dd>{project.canonicalSourcePath}</dd>
              </div>
              <div>
                <dt>Workbench copy</dt>
                <dd>{project.runtimePath}</dd>
              </div>
              <div>
                <dt>Latest baseline</dt>
                <dd>
                  Revision {project.baselines.at(-1)?.revision ?? "missing"}
                </dd>
              </div>
            </dl>
            <label className="studio-select">
              Canonical brief
              <select
                value={selectedBriefId}
                onChange={(event) =>
                  setSelectedBriefId(event.currentTarget.value)
                }
              >
                <option value="">Choose a brief</option>
                {library.briefs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="studio-reference-list">
              <legend>References to discuss with the agent</legend>
              {library.inspirations.map((item) => (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    checked={selectedReferenceIds.includes(item.id)}
                    onChange={() => toggleReference(item.id)}
                  />
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {item.aestheticFamily} · {item.status}
                    </small>
                  </span>
                </label>
              ))}
            </fieldset>
            <button
              type="button"
              className="studio-wide-net"
              disabled={working || !selectedBriefId}
              onClick={() => void createWideNet()}
            >
              Create five-direction board
            </button>
            <ol className="studio-rounds">
              {rounds.map((item) => (
                <li key={item.id} data-selected={item.id === round?.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedRoundId(item.id)}
                  >
                    <span>Round {item.sequence}</span>
                    <strong>{item.stage}</strong>
                    <small>
                      {item.payload.optionCount === 3
                        ? "3 options"
                        : item.comparisonId
                          ? "Comparison linked"
                          : item.status}
                    </small>
                  </button>
                </li>
              ))}
            </ol>
          </section>

          <AgentPanel
            repository={repository}
            project={project}
            round={round}
            brief={brief}
            references={references}
            session={session}
            onSession={setSession}
          />
        </div>
      ) : (
        setup
      )}
    </main>
  );
}
