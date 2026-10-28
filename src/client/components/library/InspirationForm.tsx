import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  captureStatuses,
  type Category,
  type Inspiration,
  type InspirationDraft,
} from "../../library/types";

interface InspirationFormProps {
  readonly categories: readonly Category[];
  readonly inspiration?: Inspiration;
  readonly onCancel: () => void;
  readonly onSave: (draft: InspirationDraft) => Promise<void>;
}

export function InspirationForm({
  categories,
  inspiration,
  onCancel,
  onSave,
}: InspirationFormProps) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setError("");
    formRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [inspiration]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const terms = String(form.get("vocabulary") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (terms.length < 5 || terms.length > 8) {
      setError("VOCABULARY_INVALID: Enter 5–8 comma-separated terms.");
      return;
    }
    const screenshot = form.get("screenshot");
    const categoryIds = form.getAll("categories").map(String);
    const draft: InspirationDraft = {
      sourceUrl: String(form.get("sourceUrl") ?? ""),
      screenshot:
        screenshot instanceof File && screenshot.size ? screenshot : undefined,
      title: String(form.get("title") ?? ""),
      aestheticFamily: String(form.get("aestheticFamily") ?? ""),
      vocabulary: terms,
      tags: String(form.get("tags") ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      categoryIds,
      status: String(form.get("status")) as InspirationDraft["status"],
      limitation: String(form.get("limitation") ?? ""),
      brief: String(form.get("brief") ?? ""),
    };
    try {
      setSaving(true);
      await onSave(draft);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "INSPIRATION_SAVE_FAILED",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      ref={formRef}
      className="editor-form"
      onSubmit={submit}
      aria-labelledby={`${id}-title`}
    >
      <header>
        <h2 id={`${id}-title`}>
          {inspiration ? "Edit reference" : "Add reference"}
        </h2>
        <p>Required fields are marked “required”.</p>
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <label>
        Source URL{" "}
        <input
          name="sourceUrl"
          type="url"
          required
          defaultValue={inspiration?.sourceUrl}
        />
      </label>
      <label>
        Screenshot{" "}
        <input
          name="screenshot"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
        />
      </label>
      <label>
        Title <input name="title" required defaultValue={inspiration?.title} />
      </label>
      <label>
        Aesthetic family{" "}
        <input
          name="aestheticFamily"
          required
          defaultValue={inspiration?.aestheticFamily}
        />
      </label>
      <label>
        Visual vocabulary (5–8, comma separated){" "}
        <input
          name="vocabulary"
          required
          defaultValue={inspiration?.vocabulary.join(", ")}
        />
      </label>
      <label>
        Tags (comma separated){" "}
        <input name="tags" defaultValue={inspiration?.tags.join(", ")} />
      </label>
      <fieldset>
        <legend>Categories</legend>
        {categories
          .filter((category) => !category.retired)
          .map((category) => (
            <label key={category.id}>
              <input
                type="checkbox"
                name="categories"
                value={category.id}
                defaultChecked={inspiration?.categoryIds.includes(category.id)}
              />
              {category.name}
              {category.provisional ? " — provisional" : ""}
            </label>
          ))}
      </fieldset>
      <label>
        Status
        <select name="status" defaultValue={inspiration?.status ?? "partial"}>
          {captureStatuses.map((status) => (
            <option key={status}>{status}</option>
          ))}
        </select>
      </label>
      <label>
        Limitation{" "}
        <textarea
          name="limitation"
          required
          defaultValue={inspiration?.limitation}
        />
      </label>
      <label>
        Brief{" "}
        <textarea name="brief" required defaultValue={inspiration?.brief} />
      </label>
      <div className="action-row">
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save reference"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
