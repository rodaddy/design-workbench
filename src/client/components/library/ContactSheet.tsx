import type { Category, Inspiration } from "../../library/types";

interface ContactSheetProps {
  readonly inspirations: readonly Inspiration[];
  readonly categories: readonly Category[];
  readonly onOpen: (inspiration: Inspiration) => void;
}

export function ContactSheet({
  inspirations,
  categories,
  onOpen,
}: ContactSheetProps) {
  const categoryNames = new Map(categories.map((item) => [item.id, item.name]));

  if (inspirations.length === 0) {
    return (
      <section className="empty-state" aria-labelledby="empty-title">
        <h2 id="empty-title">No references on this sheet</h2>
        <p>Adjust the filters or add a reference.</p>
      </section>
    );
  }

  return (
    <ol className="contact-sheet" aria-label="Inspiration references">
      {inspirations.map((inspiration, index) => {
        const leadAsset = inspiration.assets[0];
        return (
          <li className="contact-sheet__cell" key={inspiration.id}>
            <button
              className="contact-sheet__open"
              type="button"
              data-inspiration-id={inspiration.id}
              onClick={() => onOpen(inspiration)}
              aria-label={`Open ${inspiration.title}`}
            >
              <span className="contact-sheet__index" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              {leadAsset ? (
                <img
                  className="contact-sheet__image"
                  src={leadAsset.url}
                  alt={leadAsset.alt}
                  width={leadAsset.width}
                  height={leadAsset.height}
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <span className="contact-sheet__missing">
                  No local evidence
                </span>
              )}
              <span className="contact-sheet__caption">
                <strong>{inspiration.title}</strong>
                <span>{inspiration.aestheticFamily}</span>
              </span>
              <span
                className="evidence-status"
                data-status={inspiration.status}
              >
                {inspiration.status}
              </span>
              <span className="contact-sheet__categories">
                {inspiration.categoryIds
                  .map((id) => categoryNames.get(id))
                  .filter(Boolean)
                  .join(" · ") || "Uncategorized"}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
