import { useCallback, useEffect, useMemo, useState } from "react";
import { defaultVariantOrigin } from "./components/compare/isolation";
import { createHttpComparisonRepository } from "./components/compare/repository";
import type { ComparisonRepository } from "./components/compare/types";
import {
  messageFromError,
  unavailableLibraryRepository,
} from "./library/repository";
import type { LibraryRepository, LibrarySnapshot } from "./library/types";
import { ComparePage } from "./pages/ComparePage";
import { LibraryBriefsPage } from "./pages/LibraryBriefsPage";
import { LibraryPage } from "./pages/LibraryPage";
import { StudioPage } from "./pages/StudioPage";
import {
  HttpStudioRepository,
  type StudioRepository,
} from "./studio/repository";

/*
THESIS: A compact dark studio console keeps inspiration → local-agent → comparison on one screen; it refuses route mastheads and dashboard cards.
OWN-WORLD: Layered dark panels, hairline rules, mono metadata labels, and one warm amber signal for state and the next action.
STORY: Scan imported evidence, discuss references with the local agent, cast directions, then compare Impeccable vs Taste proofs.
FIRST VIEWPORT: A ~44px app bar (wordmark, route tabs, live status) sits above a workspace that fills the viewport immediately.
FORM: Operate mode, studio-console register; the workspace owns the remaining 100dvh with no display headings or whitespace before the tool.
*/

const emptySnapshot: LibrarySnapshot = {
  inspirations: [],
  categories: [],
  briefs: [],
  captureTypes: [],
  sources: [],
  tags: [],
  systemStatus: "degraded",
  statusMessage: "Library data has not loaded.",
};

function routeFromPath(
  pathname: string,
): "library" | "briefs" | "studio" | "compare" {
  if (pathname.startsWith("/briefs")) return "briefs";
  if (pathname.startsWith("/studio")) return "studio";
  if (pathname.startsWith("/compare")) return "compare";
  return "library";
}

export interface AppProps {
  readonly repository?: LibraryRepository;
  readonly comparisonRepository?: ComparisonRepository;
  readonly variantOrigin?: string;
  readonly studioRepository?: StudioRepository;
}

export function App({
  repository = unavailableLibraryRepository,
  comparisonRepository,
  variantOrigin,
  studioRepository,
}: AppProps) {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const route = routeFromPath(pathname);
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>(emptySnapshot);
  const [loading, setLoading] = useState(true);
  const [globalError, setGlobalError] = useState("");
  const compareRepository = useMemo(
    () =>
      comparisonRepository ??
      createHttpComparisonRepository({ apiOrigin: window.location.origin }),
    [comparisonRepository],
  );
  const activeStudioRepository = useMemo(
    () => studioRepository ?? new HttpStudioRepository(),
    [studioRepository],
  );
  const isolatedVariantOrigin =
    variantOrigin ??
    document.querySelector<HTMLMetaElement>('meta[name="variant-origin"]')
      ?.content ??
    defaultVariantOrigin(window.location.href);

  const refresh = useCallback(async () => {
    try {
      const next = await repository.load();
      setSnapshot(next);
      setGlobalError("");
    } catch (error) {
      setSnapshot(emptySnapshot);
      setGlobalError(messageFromError(error));
    } finally {
      setLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  function navigate(path: string) {
    window.history.pushState(null, "", path);
    setPathname(path);
  }

  return (
    <div className="app-shell" data-system-status={snapshot.systemStatus}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="app-bar">
        <a
          href="/library"
          onClick={(event) => {
            event.preventDefault();
            navigate("/library");
          }}
          className="wordmark"
        >
          Design Workbench
        </a>
        <nav aria-label="Primary">
          <a
            aria-current={route === "library" ? "page" : undefined}
            href="/library"
            onClick={(event) => {
              event.preventDefault();
              navigate("/library");
            }}
          >
            Library
          </a>
          <a
            aria-current={route === "briefs" ? "page" : undefined}
            href="/briefs"
            onClick={(event) => {
              event.preventDefault();
              navigate("/briefs");
            }}
          >
            Briefs
          </a>
          <a
            aria-current={route === "studio" ? "page" : undefined}
            href="/studio"
            onClick={(event) => {
              event.preventDefault();
              navigate("/studio");
            }}
          >
            Studio
          </a>
          <a
            aria-current={route === "compare" ? "page" : undefined}
            href="/compare"
            onClick={(event) => {
              event.preventDefault();
              navigate("/compare");
            }}
          >
            Compare
          </a>
        </nav>
        <p className="system-status" role="status">
          <span
            aria-hidden="true"
            data-indicator={globalError ? "error" : snapshot.systemStatus}
          />
          {loading ? "Loading library…" : globalError || snapshot.statusMessage}
        </p>
      </header>
      {globalError && route !== "compare" ? (
        <main id="main-content" className="system-failure">
          <h1>Library contract unavailable</h1>
          <p role="alert">{globalError}</p>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void refresh();
            }}
          >
            Retry connection
          </button>
        </main>
      ) : route === "library" ? (
        <LibraryPage
          repository={repository}
          snapshot={snapshot}
          refresh={refresh}
        />
      ) : route === "briefs" ? (
        <LibraryBriefsPage
          repository={repository}
          snapshot={snapshot}
          refresh={refresh}
        />
      ) : route === "studio" ? (
        <StudioPage
          library={snapshot}
          comparisonRepository={compareRepository}
          navigate={navigate}
          repository={activeStudioRepository}
        />
      ) : (
        <ComparePage
          pathname={pathname}
          library={snapshot}
          libraryRepository={repository}
          comparisonRepository={compareRepository}
          refreshLibrary={refresh}
          variantOrigin={isolatedVariantOrigin}
          trustedOrigin={window.location.origin}
          navigate={navigate}
          studioRepository={activeStudioRepository}
        />
      )}
    </div>
  );
}

export default App;
