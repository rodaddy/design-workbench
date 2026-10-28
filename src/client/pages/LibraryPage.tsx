import { useEffect, useMemo, useRef, useState } from "react";
import { ContactSheet } from "../components/library/ContactSheet";
import { InspirationDialog } from "../components/library/InspirationDialog";
import { InspirationForm } from "../components/library/InspirationForm";
import { messageFromError } from "../library/repository";
import type {
  Inspiration,
  InspirationDraft,
  LibraryRepository,
  LibrarySnapshot,
} from "../library/types";
import { LibraryRepositoryError } from "../library/types";

interface LibraryPageProps {
  readonly repository: LibraryRepository;
  readonly snapshot: LibrarySnapshot;
  readonly refresh: () => Promise<void>;
}

const documented = (value?: string) => value?.trim() || "Not documented";

export function LibraryPage({
  repository,
  snapshot,
  refresh,
}: LibraryPageProps) {
  const [selected, setSelected] = useState<Inspiration | null>(null);
  const [panelId, setPanelId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Inspiration | "new" | null>(null);
  const [notice, setNotice] = useState("");
  const editorOpenerRef = useRef<HTMLElement | null>(null);
  const editorInspirationIdRef = useRef<string | null>(null);
  const [filters, setFilters] = useState({
    query: "",
    category: "",
    tag: "",
    source: "",
    captureType: "",
    status: "",
    confidence: "",
  });

  const results = useMemo(
    () =>
      snapshot.inspirations.filter((item) => {
        const query = filters.query.trim().toLowerCase();
        return (
          (!query ||
            [
              item.title,
              item.aestheticFamily,
              item.brief,
              ...item.vocabulary,
              ...item.tags,
            ].some((value) => value.toLowerCase().includes(query))) &&
          (!filters.category || item.categoryIds.includes(filters.category)) &&
          (!filters.tag || item.tags.includes(filters.tag)) &&
          (!filters.source || item.source === filters.source) &&
          (!filters.captureType || item.captureType === filters.captureType) &&
          (!filters.status || item.status === filters.status) &&
          (!filters.confidence || item.confidence === filters.confidence)
        );
      }),
    [filters, snapshot.inspirations],
  );

  // Keep the panel selection valid: default to the first result and recompute
  // when the current selection is filtered away or the data changes.
  useEffect(() => {
    if (results.length === 0) {
      if (panelId !== null) setPanelId(null);
      return;
    }
    if (!panelId || !results.some((item) => item.id === panelId)) {
      setPanelId(results[0].id);
    }
  }, [results, panelId]);

  const panelInspiration = results.find((item) => item.id === panelId) ?? null;

  function change(name: keyof typeof filters, value: string) {
    setFilters((current) => ({ ...current, [name]: value }));
  }

  function rememberEditorOpener() {
    editorOpenerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    editorInspirationIdRef.current = null;
  }

  function rememberInspirationOpener(id: string) {
    rememberEditorOpener();
    editorInspirationIdRef.current = id;
  }

  function restoreEditorOpener() {
    const opener = editorOpenerRef.current;
    const inspirationId = editorInspirationIdRef.current;
    editorOpenerRef.current = null;
    editorInspirationIdRef.current = null;
    queueMicrotask(() => {
      if (opener?.isConnected) {
        opener.focus();
        return;
      }
      if (!inspirationId) return;
      const replacement = [
        ...document.querySelectorAll<HTMLElement>("[data-inspiration-id]"),
      ].find((candidate) => candidate.dataset.inspirationId === inspirationId);
      replacement?.focus();
    });
  }

  function cancelEditing() {
    setEditing(null);
    restoreEditorOpener();
  }

  async function save(draft: InspirationDraft) {
    try {
      if (editing && editing !== "new")
        await repository.updateInspiration(editing.id, draft);
      else await repository.createInspiration(draft);
    } catch (error) {
      if (
        error instanceof LibraryRepositoryError &&
        error.code === "INSPIRATION_ASSET_UPLOAD_PARTIAL"
      ) {
        setEditing(null);
        await refresh();
        setNotice(error.message);
        restoreEditorOpener();
        return;
      }
      throw error;
    }
    setEditing(null);
    await refresh();
    setNotice("Reference saved.");
    restoreEditorOpener();
  }

  async function createBrief(id: string) {
    try {
      await repository.createBriefFromInspiration(id);
      await refresh();
      setNotice("Brief created from inspiration.");
    } catch (error) {
      const message = messageFromError(error);
      setNotice(message);
      throw new Error(message, { cause: error });
    }
  }

  return (
    <main id="main-content" className="library-surface">
      <header className="surface-heading">
        <div>
          <p>Inspiration</p>
          <h1>Library</h1>
        </div>
        <p>
          {results.length} of {snapshot.inspirations.length} references in view
        </p>
        <button
          type="button"
          onClick={() => {
            rememberEditorOpener();
            setEditing("new");
          }}
        >
          Add reference
        </button>
      </header>
      <p className="operation-notice" role="status" aria-live="polite">
        {notice}
      </p>
      <form
        className="filter-rail"
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          Search{" "}
          <input
            type="search"
            value={filters.query}
            onChange={(event) => change("query", event.currentTarget.value)}
          />
        </label>
        <Filter
          label="Category"
          value={filters.category}
          onChange={(value) => change("category", value)}
          options={snapshot.categories
            .filter((item) => !item.retired)
            .map((item) => [item.id, item.name])}
        />
        <Filter
          label="Tag"
          value={filters.tag}
          onChange={(value) => change("tag", value)}
          options={snapshot.tags.map((value) => [value, value])}
        />
        <Filter
          label="Source"
          value={filters.source}
          onChange={(value) => change("source", value)}
          options={snapshot.sources.map((value) => [value, value])}
        />
        <Filter
          label="Capture type"
          value={filters.captureType}
          onChange={(value) => change("captureType", value)}
          options={snapshot.captureTypes.map((value) => [value, value])}
        />
        <Filter
          label="Status"
          value={filters.status}
          onChange={(value) => change("status", value)}
          options={["captured", "partial", "blocked"].map((value) => [
            value,
            value,
          ])}
        />
        <Filter
          label="Confidence"
          value={filters.confidence}
          onChange={(value) => change("confidence", value)}
          options={["high", "medium", "low"].map((value) => [value, value])}
        />
        <button
          type="button"
          onClick={() =>
            setFilters({
              query: "",
              category: "",
              tag: "",
              source: "",
              captureType: "",
              status: "",
              confidence: "",
            })
          }
        >
          Clear filters
        </button>
      </form>
      {editing ? (
        <InspirationForm
          categories={snapshot.categories}
          inspiration={editing === "new" ? undefined : editing}
          onCancel={cancelEditing}
          onSave={save}
        />
      ) : (
        <div className="library-split">
          <div className="library-grid-pane">
            <div className="library-grid-scroll">
              <ContactSheet
                inspirations={results}
                categories={snapshot.categories}
                onOpen={(item) => {
                  rememberInspirationOpener(item.id);
                  setPanelId(item.id);
                  setSelected(item);
                }}
              />
            </div>
            <CategoryManager
              repository={repository}
              snapshot={snapshot}
              refresh={refresh}
              setNotice={setNotice}
            />
          </div>
          <DetailPanel
            inspiration={panelInspiration}
            onEdit={(item) => {
              rememberInspirationOpener(item.id);
              setEditing(item);
            }}
            onCreateBrief={createBrief}
            onClear={() => setPanelId(null)}
          />
        </div>
      )}
      <InspirationDialog
        inspiration={selected}
        onClose={() => setSelected(null)}
        onEdit={(item) => {
          setSelected(null);
          setEditing(item);
        }}
        onCreateBrief={createBrief}
      />
    </main>
  );
}

function DetailPanel({
  inspiration,
  onEdit,
  onCreateBrief,
  onClear,
}: {
  inspiration: Inspiration | null;
  onEdit: (inspiration: Inspiration) => void;
  onCreateBrief: (id: string) => Promise<void>;
  onClear: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const [briefStatus, setBriefStatus] = useState("");
  const [creatingBrief, setCreatingBrief] = useState(false);

  useEffect(() => {
    setCopyStatus("");
    setBriefStatus("");
  }, [inspiration]);

  if (!inspiration) {
    return (
      <aside className="detail-panel" aria-label="Selected reference">
        <div className="detail-panel__empty">
          <strong>No reference selected</strong>
          <p>Select a reference from the sheet to inspect its analysis.</p>
        </div>
      </aside>
    );
  }

  async function copy(label: "brief" | "prompt", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label === "brief" ? "Brief" : "Prompt"} copied.`);
    } catch {
      setCopyStatus(`COPY_FAILED: Select and copy the ${label} text manually.`);
    }
  }

  async function createBrief() {
    if (!inspiration) return;
    setBriefStatus("");
    setCreatingBrief(true);
    try {
      await onCreateBrief(inspiration.id);
      setBriefStatus("Brief created from inspiration.");
    } catch (error) {
      setBriefStatus(
        error instanceof Error
          ? error.message
          : "BRIEF_CREATE_FAILED: The brief could not be created.",
      );
    } finally {
      setCreatingBrief(false);
    }
  }

  return (
    <aside className="detail-panel" aria-label="Selected reference">
      <header className="detail-panel__header">
        <p className="detail-panel__source">{inspiration.source}</p>
        <h2>{inspiration.title}</h2>
        <button type="button" onClick={onClear}>
          Clear selection
        </button>
      </header>
      <div className="detail-panel__body">
        <section aria-label="Analysis">
          <h3>Analysis</h3>
          <dl className="detail-ledger">
            <div>
              <dt>Purpose</dt>
              <dd>{documented(inspiration.purpose)}</dd>
            </div>
            <div>
              <dt>Aesthetic family</dt>
              <dd>{inspiration.aestheticFamily}</dd>
            </div>
            <div>
              <dt>Composition</dt>
              <dd>{documented(inspiration.composition)}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{documented(inspiration.typography)}</dd>
            </div>
            <div>
              <dt>Color / material</dt>
              <dd>{documented(inspiration.colorMaterial)}</dd>
            </div>
            <div>
              <dt>Motion</dt>
              <dd>{documented(inspiration.motion)}</dd>
            </div>
            <div>
              <dt>Borrow</dt>
              <dd>{documented(inspiration.borrow)}</dd>
            </div>
            <div>
              <dt>Avoid</dt>
              <dd>{documented(inspiration.avoid)}</dd>
            </div>
            <div>
              <dt>Limitation</dt>
              <dd>{documented(inspiration.limitation)}</dd>
            </div>
          </dl>
        </section>
        <section aria-label="Visual vocabulary">
          <h3>Visual vocabulary</h3>
          <ul className="term-list">
            {inspiration.vocabulary.map((term) => (
              <li key={term}>{term}</li>
            ))}
          </ul>
        </section>
        <section aria-label="Evidence strip">
          <h3>Evidence strip</h3>
          {inspiration.assets.length ? (
            <ul className="asset-strip">
              {inspiration.assets.map((asset) => (
                <li key={asset.id}>
                  <img
                    src={asset.url}
                    alt={`${asset.alt} · evidence thumbnail`}
                    width={asset.width}
                    height={asset.height}
                    loading="lazy"
                    decoding="async"
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p>No local evidence is attached.</p>
          )}
        </section>
        <section className="copy-block" aria-label="Brief">
          <h3>Brief</h3>
          <pre>{inspiration.brief}</pre>
          <div className="action-row">
            <button
              type="button"
              onClick={() => copy("brief", inspiration.brief)}
            >
              Copy brief
            </button>
            <button
              type="button"
              disabled={!inspiration.prompt}
              title={
                inspiration.prompt ? undefined : "No exact prompt is documented"
              }
              onClick={() =>
                inspiration.prompt && copy("prompt", inspiration.prompt)
              }
            >
              Copy prompt
            </button>
          </div>
          <p role="status" aria-live="polite">
            {copyStatus}
          </p>
        </section>
      </div>
      <footer className="detail-panel__footer">
        <a href={inspiration.sourceUrl} target="_blank" rel="noreferrer">
          Open source
        </a>
        <button type="button" onClick={() => onEdit(inspiration)}>
          Edit reference
        </button>
        <button
          type="button"
          disabled={creatingBrief}
          onClick={() => void createBrief()}
        >
          {creatingBrief ? "Creating brief…" : "Create brief from inspiration"}
        </button>
        <p
          className="detail-panel__operation"
          role={briefStatus.includes("_") ? "alert" : "status"}
          aria-live="polite"
        >
          {briefStatus}
        </p>
      </footer>
    </aside>
  );
}

function Filter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <option value="">All</option>
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function CategoryManager({
  repository,
  snapshot,
  refresh,
  setNotice,
}: {
  repository: LibraryRepository;
  snapshot: LibrarySnapshot;
  refresh: () => Promise<void>;
  setNotice: (value: string) => void;
}) {
  async function rename(id: string, form: HTMLFormElement) {
    const name = String(new FormData(form).get("name") ?? "").trim();
    if (!name)
      return setNotice("CATEGORY_NAME_REQUIRED: Enter a category name.");
    try {
      await repository.renameCategory(id, name);
      await refresh();
      setNotice("Category renamed.");
    } catch (error) {
      setNotice(messageFromError(error));
    }
  }
  async function retire(id: string) {
    try {
      await repository.retireCategory(id);
      await refresh();
      setNotice("Category retired.");
    } catch (error) {
      setNotice(messageFromError(error));
    }
  }
  return (
    <section className="category-ledger" aria-labelledby="category-title">
      <h2 id="category-title">Category register</h2>
      <p>Provisional video seeds remain visible until retired.</p>
      <ul>
        {snapshot.categories.map((category) => (
          <li key={category.id} data-retired={category.retired}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void rename(category.id, event.currentTarget);
              }}
            >
              <label>
                Name{" "}
                <input
                  name="name"
                  defaultValue={category.name}
                  disabled={category.retired}
                />
              </label>
              <span>
                {category.provisional ? "Provisional seed" : "Established"}
                {category.retired ? " · Retired" : ""}
              </span>
              <button type="submit" disabled={category.retired}>
                Rename
              </button>
              <button
                type="button"
                disabled={category.retired}
                onClick={() => void retire(category.id)}
              >
                Retire
              </button>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}
