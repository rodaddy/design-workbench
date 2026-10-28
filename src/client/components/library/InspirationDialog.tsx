import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { Inspiration } from "../../library/types";

interface InspirationDialogProps {
  readonly inspiration: Inspiration | null;
  readonly onClose: () => void;
  readonly onEdit: (inspiration: Inspiration) => void;
  readonly onCreateBrief: (id: string) => Promise<void>;
}

const documented = (value?: string) => value?.trim() || "Not documented";

export function InspirationDialog({
  inspiration,
  onClose,
  onEdit,
  onCreateBrief,
}: InspirationDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [briefStatus, setBriefStatus] = useState("");
  const [creatingBrief, setCreatingBrief] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (inspiration && dialog && !dialog.open) {
      openerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      dialog.showModal();
    }
    if (!inspiration && dialog?.open) dialog.close();
    setCopyStatus("");
    setBriefStatus("");
  }, [inspiration]);

  if (!inspiration) return null;

  async function copy(label: "brief" | "prompt", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label === "brief" ? "Brief" : "Prompt"} copied.`);
    } catch {
      setCopyStatus(`COPY_FAILED: Select and copy the ${label} text manually.`);
    }
  }

  function closeDialog() {
    dialogRef.current?.close();
  }

  function handleClose() {
    const opener = openerRef.current;
    onClose();
    queueMicrotask(() => opener?.focus());
  }

  function handleCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    closeDialog();
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

  function editInspiration() {
    if (!inspiration) return;
    openerRef.current = null;
    onEdit(inspiration);
  }

  return (
    <dialog
      ref={dialogRef}
      className="detail-drawer"
      aria-labelledby="detail-title"
      onClose={handleClose}
      onCancel={handleCancel}
    >
      <header className="detail-drawer__header">
        <p className="detail-drawer__source">{inspiration.source}</p>
        <h2 id="detail-title">{inspiration.title}</h2>
        <button type="button" onClick={closeDialog}>
          Close
        </button>
      </header>
      <div className="detail-drawer__body">
        <section aria-labelledby="detail-analysis">
          <h3 id="detail-analysis">Analysis</h3>
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
        <section aria-labelledby="detail-vocabulary">
          <h3 id="detail-vocabulary">Visual vocabulary</h3>
          <ul className="term-list">
            {inspiration.vocabulary.map((term) => (
              <li key={term}>{term}</li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="detail-assets">
          <h3 id="detail-assets">Evidence strip</h3>
          {inspiration.assets.length ? (
            <ul className="asset-strip">
              {inspiration.assets.map((asset) => (
                <li key={asset.id}>
                  <img
                    src={asset.url}
                    alt={asset.alt}
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
        <section className="copy-block" aria-labelledby="detail-brief">
          <h3 id="detail-brief">Brief</h3>
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
          {!inspiration.prompt && (
            <p>Prompt unavailable: no exact prompt is documented.</p>
          )}
        </section>
      </div>
      <footer className="detail-drawer__footer">
        <a href={inspiration.sourceUrl} target="_blank" rel="noreferrer">
          Open source
        </a>
        <button type="button" onClick={editInspiration}>
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
          className="detail-drawer__operation"
          role={briefStatus.includes("_") ? "alert" : "status"}
          aria-live="polite"
        >
          {briefStatus}
        </p>
      </footer>
    </dialog>
  );
}
