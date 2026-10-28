import { useState, type FormEvent } from "react";
import { parseDesignBrief } from "../../shared/brief";
import { messageFromError } from "../library/repository";
import type { LibraryRepository, LibrarySnapshot } from "../library/types";

export function LibraryBriefsPage({
  repository,
  snapshot,
  refresh,
}: {
  readonly repository: LibraryRepository;
  readonly snapshot: LibrarySnapshot;
  readonly refresh: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const markdown = String(
      new FormData(event.currentTarget).get("markdown") ?? "",
    );
    try {
      parseDesignBrief(markdown);
      await repository.importBrief({ markdown });
      await refresh();
      event.currentTarget.reset();
      setNotice("Brief imported.");
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }
  return (
    <main id="main-content" className="briefs-surface">
      <header className="surface-heading">
        <div>
          <p>Canonical packets</p>
          <h1>Briefs</h1>
        </div>
        <p>
          {snapshot.briefs.length} saved{" "}
          {snapshot.briefs.length === 1 ? "brief" : "briefs"}
        </p>
      </header>
      <p className="operation-notice" role="status" aria-live="polite">
        {notice}
      </p>
      <div className="briefs-body">
        <section aria-labelledby="saved-briefs">
          <h2 id="saved-briefs">Saved briefs</h2>
          {snapshot.briefs.length ? (
            <ol className="brief-register">
              {snapshot.briefs.map((brief) => (
                <li key={brief.id}>
                  <h3>{brief.title}</h3>
                  <p>
                    {brief.sourceInspirationId
                      ? "Prefilled from Library"
                      : "Imported"}
                  </p>
                  <details>
                    <summary>Read Markdown</summary>
                    <pre>{brief.markdown}</pre>
                  </details>
                </li>
              ))}
            </ol>
          ) : (
            <p>No briefs have been imported.</p>
          )}
        </section>
        <section aria-labelledby="import-brief">
          <h2 id="import-brief">Import canonical Markdown</h2>
          <p>
            Use the design-brief-grill section order. Invalid or incomplete
            packets are rejected.
          </p>
          <form className="brief-import" onSubmit={submit}>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <label>
              Brief Markdown
              <textarea name="markdown" required rows={22} />
            </label>
            <button type="submit">Import brief</button>
          </form>
        </section>
      </div>
    </main>
  );
}
