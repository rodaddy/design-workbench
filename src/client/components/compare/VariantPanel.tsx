import { useEffect, useMemo, useRef, useState } from "react";
import {
  probeVariantAvailability,
  VARIANT_IFRAME_SANDBOX,
  variantUrl,
} from "./isolation";
import { calculateFrameScale, viewports, type ViewportName } from "./model";
import { TweakBar } from "../../studio/TweakBar";
import type { ComparisonEngine, ComparisonVariant } from "./types";

function metadataEntries(
  metadata: Record<string, unknown>,
): readonly [string, string][] {
  return Object.entries(metadata).map(([key, value]) => [
    key,
    typeof value === "string" ? value : JSON.stringify(value),
  ]);
}

export function VariantPanel({
  engine,
  directionTitle,
  variant,
  viewport,
  variantOrigin,
  trustedOrigin,
  display = "detail",
}: {
  readonly engine: ComparisonEngine;
  readonly directionTitle: string;
  readonly variant?: ComparisonVariant;
  readonly viewport: ViewportName;
  readonly variantOrigin: string;
  readonly trustedOrigin: string;
  readonly display?: "detail" | "overview";
}) {
  const label = engine === "impeccable" ? "Impeccable" : "Taste Skill";
  const frame = viewports[viewport];
  const shellRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameWindow, setFrameWindow] = useState<Window | null>(null);
  const [availableWidth, setAvailableWidth] = useState<number>(frame.width);
  const [frameState, setFrameState] = useState<
    "checking" | "loading" | "ready" | "error"
  >("checking");
  const [frameError, setFrameError] = useState("");
  const source = useMemo(() => {
    if (!variant) return undefined;
    try {
      return variantUrl(variant.artifactPath, variantOrigin, trustedOrigin);
    } catch {
      return undefined;
    }
  }, [trustedOrigin, variant, variantOrigin]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailableWidth(entry.contentRect.width);
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setFrameWindow(null);
    if (!source) return;
    const controller = new AbortController();
    setFrameState("checking");
    setFrameError("");
    void probeVariantAvailability(source, fetch, controller.signal)
      .then(() => setFrameState("loading"))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFrameState("error");
        setFrameError(
          error instanceof Error
            ? error.message
            : "VARIANT_ARTIFACT_UNAVAILABLE: Artifact verification failed.",
        );
      });
    return () => controller.abort();
  }, [source, viewport]);

  const scale = calculateFrameScale(availableWidth, frame.width);
  const metadata = variant ? metadataEntries(variant.metadata) : [];

  return (
    <article
      className="variant-panel"
      data-engine={engine}
      data-display={display}
    >
      <header>
        <div>
          <p>{engine}</p>
          <h2>{label}</h2>
        </div>
        <dl>
          <div>
            <dt>Direction</dt>
            <dd>{directionTitle}</dd>
          </div>
          <div>
            <dt>Artifact</dt>
            <dd>
              {variant
                ? new Date(variant.updatedAt).toLocaleString()
                : "Not registered"}
            </dd>
          </div>
        </dl>
      </header>

      {!variant ? (
        <div className="variant-state" data-state="missing">
          <strong>{label} output is missing</strong>
          <p>
            Copy the packet below, generate into its exact directory, then
            register the artifact.
          </p>
        </div>
      ) : !source ? (
        <div className="variant-state" data-state="error" role="alert">
          <strong>Artifact path rejected</strong>
          <p>
            The variant path or origin violates the isolated-frame contract.
          </p>
        </div>
      ) : frameState === "checking" ? (
        <div className="variant-state" data-state="checking">
          <strong>Verifying {label} output</strong>
          <p>
            Checking the isolated variant origin before opening the artifact.
          </p>
        </div>
      ) : frameState === "error" ? (
        <div className="variant-state" data-state="error" role="alert">
          <strong>{label} output is unavailable</strong>
          <p>{frameError}</p>
        </div>
      ) : (
        <>
          <p className="frame-status" role="status">
            {frameState === "loading"
              ? `Loading ${label} artifact…`
              : `${label} artifact loaded.`}
          </p>
          <div
            className="viewport-shell"
            ref={shellRef}
            style={{ height: `${frame.height * scale}px` }}
          >
            <div
              className="viewport-scaler"
              style={{
                width: `${frame.width}px`,
                height: `${frame.height}px`,
                transform: `scale(${scale})`,
              }}
            >
              <iframe
                key={`${source}-${viewport}`}
                ref={iframeRef}
                title={`${label}: ${directionTitle} at ${frame.label} viewport`}
                src={source}
                width={frame.width}
                height={frame.height}
                sandbox={VARIANT_IFRAME_SANDBOX}
                referrerPolicy="no-referrer"
                onLoad={() => {
                  setFrameState("ready");
                  setFrameWindow(iframeRef.current?.contentWindow ?? null);
                }}
              />
            </div>
          </div>
          {display === "detail" && variant ? (
            <TweakBar
              artifactPath={variant.artifactPath}
              variantId={variant.id}
              variantOrigin={variantOrigin}
              targetWindow={frameWindow}
            />
          ) : null}
        </>
      )}

      <details className="variant-metadata">
        <summary>Artifact metadata</summary>
        <dl>
          <div>
            <dt>Engine</dt>
            <dd>{label}</dd>
          </div>
          <div>
            <dt>Viewport</dt>
            <dd>
              {frame.label} · {frame.width} × {frame.height}
            </dd>
          </div>
          <div>
            <dt>Path</dt>
            <dd>{variant?.artifactPath ?? "Awaiting registration"}</dd>
          </div>
          {metadata.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </article>
  );
}
