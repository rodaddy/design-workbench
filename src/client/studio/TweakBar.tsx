import { useEffect, useMemo, useState } from "react";
import {
  workbenchTweakManifestSchema,
  type WorkbenchTweakControl,
} from "../../shared/tweaks";
import { createWorkbenchTweakMessage } from "../components/compare/tweaks";

function defaultValue(control: WorkbenchTweakControl) {
  return control.default;
}

interface SavedDecisionSet {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly decisions: Record<string, boolean | number | string>;
}

export function TweakBar({
  artifactPath,
  variantId,
  variantOrigin,
  targetWindow,
}: {
  readonly artifactPath: string;
  readonly variantId: string;
  readonly variantOrigin: string;
  readonly targetWindow: Window | null;
}) {
  const [open, setOpen] = useState(false);
  const [manifest, setManifest] = useState<ReturnType<
    typeof workbenchTweakManifestSchema.parse
  > | null>(null);
  const [values, setValues] = useState<
    Record<string, boolean | number | string>
  >({});
  const [status, setStatus] = useState("");
  const [saved, setSaved] = useState<readonly SavedDecisionSet[]>([]);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const manifestUrl = useMemo(() => {
    const base = variantOrigin.endsWith("/")
      ? variantOrigin
      : `${variantOrigin}/`;
    return new URL(
      `${artifactPath.replace(/^\/+/, "")}/workbench.json`,
      base,
    ).toString();
  }, [artifactPath, variantOrigin]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(manifestUrl, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) return null;
        if (!response.ok)
          throw new Error(`Tweak manifest failed (${response.status})`);
        return workbenchTweakManifestSchema.parse(await response.json());
      })
      .then((next) => {
        if (!next) return;
        setManifest(next);
        setValues(
          Object.fromEntries(
            next.controls.map((control) => [control.id, defaultValue(control)]),
          ),
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setStatus(
            error instanceof Error ? error.message : "Tweak manifest failed",
          );
        }
      });
    return () => controller.abort();
  }, [manifestUrl]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch(
      `/api/variants/${encodeURIComponent(variantId)}/tweak-decisions`,
      {
        signal: controller.signal,
      },
    )
      .then((response) => (response.ok ? response.json() : []))
      .then((rows: SavedDecisionSet[]) => setSaved(rows))
      .catch(() => {
        // A missing decision list must not block live tweaking, which works
        // entirely in the frame and needs no server round trip.
      });
    return () => controller.abort();
  }, [open, variantId]);

  if (!manifest) return null;

  function apply(
    control: WorkbenchTweakControl,
    value: boolean | number | string,
  ) {
    if (!manifest || !targetWindow) return;
    const message = createWorkbenchTweakMessage(manifest, control.id, value);
    targetWindow.postMessage(message, new URL(variantOrigin).origin);
    setValues((current) => ({ ...current, [control.id]: value }));
    setStatus(`${control.label} updated.`);
  }

  function reset() {
    if (!manifest) return;
    for (const control of manifest.controls)
      apply(control, defaultValue(control));
    setStatus("Tweak defaults restored.");
  }

  /**
   * Decision persistence talks to the trusted workbench origin, never to the
   * variant origin the generated page is served from.
   */
  async function call(path: string, init?: RequestInit) {
    const response = await fetch(path, {
      ...init,
      headers: init?.body ? { "content-type": "application/json" } : undefined,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload &&
        typeof payload === "object" &&
        "message" in payload &&
        typeof payload.message === "string"
          ? payload.message
          : `Request failed (${response.status})`;
      throw new Error(message);
    }
    return payload;
  }

  async function withStatus(done: string, work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
      setStatus(done);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Tweak action failed");
    } finally {
      setBusy(false);
    }
  }

  async function refreshSaved() {
    const rows = (await call(
      `/api/variants/${encodeURIComponent(variantId)}/tweak-decisions`,
    )) as SavedDecisionSet[];
    setSaved(rows);
  }

  function save() {
    void withStatus("Tweak decisions saved.", async () => {
      await call(
        `/api/variants/${encodeURIComponent(variantId)}/tweak-decisions`,
        {
          method: "POST",
          body: JSON.stringify({
            label: label.trim(),
            decisions: values,
            // A fresh key per save: two saves of the same values are two
            // deliberate decisions, not one request retried.
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      setLabel("");
      await refreshSaved();
    });
  }

  /**
   * Restoring re-validates server-side against the manifest as it is now, so a
   * decision set taken before a regeneration reports a mismatch here rather
   * than silently pushing stale values into the frame.
   */
  function restore(decisionId: string) {
    void withStatus("Tweak decisions restored.", async () => {
      const result = (await call(
        `/api/tweak-decisions/${encodeURIComponent(decisionId)}`,
      )) as { decisions: Record<string, boolean | number | string> };
      if (!manifest) return;
      for (const control of manifest.controls) {
        const value = result.decisions[control.id];
        if (value !== undefined) apply(control, value);
      }
    });
  }

  function applyPermanently(decisionId: string) {
    void withStatus(
      "Agent is writing these values into a new artifact revision.",
      async () => {
        await call(
          `/api/tweak-decisions/${encodeURIComponent(decisionId)}/apply`,
          { method: "POST" },
        );
      },
    );
  }

  return (
    <div className="tweak-bar" data-open={open}>
      <button
        type="button"
        className="tweak-trigger"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Close tweaks" : "Tweaks"}
      </button>
      {open ? (
        <aside aria-label="Visual tweak controls">
          <header>
            <div>
              <p>Live decisions</p>
              <h3>Tweak selected proof</h3>
            </div>
            <button type="button" onClick={reset}>
              Reset
            </button>
          </header>
          <div className="tweak-controls">
            {manifest.controls.map((control) => (
              <label key={control.id}>
                <span>{control.label}</span>
                {control.type === "choice" ? (
                  <select
                    value={String(values[control.id] ?? control.default)}
                    onChange={(event) =>
                      apply(control, event.currentTarget.value)
                    }
                  >
                    {control.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : control.type === "number" ? (
                  <span className="tweak-number">
                    <input
                      type="range"
                      min={control.min}
                      max={control.max}
                      step={control.step}
                      value={Number(values[control.id] ?? control.default)}
                      onChange={(event) =>
                        apply(control, Number(event.currentTarget.value))
                      }
                    />
                    <output>
                      {values[control.id] ?? control.default}
                      {control.unit}
                    </output>
                  </span>
                ) : control.type === "color" ? (
                  <input
                    type="color"
                    value={String(values[control.id] ?? control.default).slice(
                      0,
                      7,
                    )}
                    onChange={(event) =>
                      apply(control, event.currentTarget.value)
                    }
                  />
                ) : (
                  <input
                    type="checkbox"
                    checked={Boolean(values[control.id] ?? control.default)}
                    onChange={(event) =>
                      apply(control, event.currentTarget.checked)
                    }
                  />
                )}
              </label>
            ))}
          </div>
          <div className="tweak-save">
            <label>
              <span>Name these decisions</span>
              <input
                type="text"
                value={label}
                maxLength={200}
                placeholder="Quieter hero"
                onChange={(event) => setLabel(event.currentTarget.value)}
              />
            </label>
            <button type="button" onClick={save} disabled={busy}>
              Save decisions
            </button>
          </div>
          {saved.length > 0 ? (
            <ul className="tweak-saved" aria-label="Saved tweak decisions">
              {saved.map((entry) => (
                <li key={entry.id}>
                  <span>{entry.label || "Untitled decisions"}</span>
                  <button
                    type="button"
                    onClick={() => restore(entry.id)}
                    disabled={busy}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    onClick={() => applyPermanently(entry.id)}
                    disabled={busy}
                  >
                    Ask agent to apply
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p role="status">{status}</p>
        </aside>
      ) : null}
    </div>
  );
}
