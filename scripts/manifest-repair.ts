/**
 * Repair generated `workbench.json` manifests that predate the enforced
 * generated-artifact contract.
 *
 * Only deterministic, safe repair is performed:
 *   - alias renames (`tweaks`/`cssCustomProperty`/`value`) via the shared
 *     normalizer,
 *   - binding the manifest to the path it is actually served from,
 *   - rewriting unsupported `length` controls, whose CSS values are `clamp()`
 *     expressions the protocol cannot express, into bounded `number` controls
 *     in `rem`.
 *
 * A control is only kept when the artifact's stylesheets actually declare the
 * custom property, so a repaired manifest never advertises a dead control.
 * Anything that cannot be repaired this way is reported and left for
 * regeneration rather than guessed at.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  normalizeWorkbenchTweakManifest,
  WorkbenchManifestNormalizationError,
} from "../src/shared/tweaks";

const LENGTH_BOUNDS = { min: 0, max: 12, step: 0.25, unit: "rem" } as const;

function cssCustomProperties(artifactDirectory: string): Set<string> {
  const declared = new Set<string>();
  const assets = resolve(artifactDirectory, "assets");
  if (!existsSync(assets)) return declared;
  for (const entry of readdirSync(assets)) {
    if (!entry.endsWith(".css")) continue;
    const css = readFileSync(resolve(assets, entry), "utf8");
    for (const match of css.matchAll(/(--[a-z][a-z0-9-]*)\s*:/g)) {
      if (match[1]) declared.add(match[1]);
    }
  }
  return declared;
}

/** Parse the first rem length out of a CSS value, including inside clamp(). */
function remFallback(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /(-?\d+(?:\.\d+)?)\s*rem/.exec(value);
  if (match?.[1] !== undefined) {
    const parsed = Number.parseFloat(match[1]);
    if (Number.isFinite(parsed)) {
      // Snap to the declared step so the value satisfies step alignment.
      return Math.min(
        LENGTH_BOUNDS.max,
        Math.max(
          LENGTH_BOUNDS.min,
          Math.round(parsed / LENGTH_BOUNDS.step) * LENGTH_BOUNDS.step,
        ),
      );
    }
  }
  if (/^\s*0(px|rem|em)?\s*$/.test(value)) return 0;
  return null;
}

export interface ManifestRepairReport {
  variantId: string;
  repaired: boolean;
  keptControls: string[];
  convertedControls: string[];
  droppedControls: { id: string; reason: string }[];
  error?: string;
}

export function repairManifestFile(
  artifactDirectory: string,
  variantId: string,
  { write = true }: { write?: boolean } = {},
): ManifestRepairReport {
  const report: ManifestRepairReport = {
    variantId,
    repaired: false,
    keptControls: [],
    convertedControls: [],
    droppedControls: [],
  };
  const manifestPath = resolve(artifactDirectory, "workbench.json");
  if (!existsSync(manifestPath)) {
    report.error = "workbench.json is absent";
    return report;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    report.error = `workbench.json is not valid JSON: ${String(error)}`;
    return report;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    report.error = "workbench.json is not an object";
    return report;
  }

  const source = raw as Record<string, unknown>;
  const rawControls = Array.isArray(source.controls)
    ? source.controls
    : Array.isArray(source.tweaks)
      ? source.tweaks
      : [];
  const declared = cssCustomProperties(artifactDirectory);

  const controls: Record<string, unknown>[] = [];
  for (const entry of rawControls) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      report.droppedControls.push({ id: "(unnamed)", reason: "not an object" });
      continue;
    }
    const control = { ...(entry as Record<string, unknown>) };
    const id = String(control.id ?? "(unnamed)");
    const property = String(
      control.property ?? control.cssCustomProperty ?? "",
    );

    if (!declared.has(property)) {
      report.droppedControls.push({
        id,
        reason: `stylesheets do not declare ${property || "a property"}`,
      });
      continue;
    }

    if (control.type === "length") {
      const fallback = remFallback(control.value ?? control.default);
      if (fallback === null) {
        report.droppedControls.push({
          id,
          reason: "length value has no convertible rem fallback",
        });
        continue;
      }
      control.type = "number";
      control.default = fallback;
      delete control.value;
      control.min = LENGTH_BOUNDS.min;
      control.max = LENGTH_BOUNDS.max;
      control.step = LENGTH_BOUNDS.step;
      control.unit = LENGTH_BOUNDS.unit;
      report.convertedControls.push(id);
    } else {
      report.keptControls.push(id);
    }
    controls.push(control);
  }

  try {
    const manifest = normalizeWorkbenchTweakManifest(
      { version: 1, controls },
      variantId,
    );
    if (write) {
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    report.repaired = true;
  } catch (error) {
    report.error =
      error instanceof WorkbenchManifestNormalizationError
        ? `${error.code}: ${error.message}`
        : String(error);
  }
  return report;
}

/** Repair every manifest under a generated-variants root. */
export function repairGeneratedRoot(
  generatedRoot: string,
  options: { write?: boolean } = {},
): ManifestRepairReport[] {
  const reports: ManifestRepairReport[] = [];
  const walk = (directory: string, segments: string[]): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "_archive" || entry.name.startsWith(".")) continue;
      const child = resolve(directory, entry.name);
      const childSegments = [...segments, entry.name];
      if (existsSync(resolve(child, "workbench.json"))) {
        reports.push(
          repairManifestFile(child, childSegments.join("/"), options),
        );
      }
      walk(child, childSegments);
    }
  };
  walk(resolve(generatedRoot), []);
  return reports;
}

if (import.meta.main) {
  const root = resolve(Bun.argv[2] ?? "generated-variants");
  const write = !Bun.argv.includes("--dry-run");
  const reports = repairGeneratedRoot(root, { write });
  for (const report of reports) {
    const status = report.error
      ? `FAILED (${report.error})`
      : write
        ? "repaired"
        : "repairable";
    console.info(`${report.variantId}: ${status}`);
    if (report.keptControls.length > 0) {
      console.info(`  kept:      ${report.keptControls.join(", ")}`);
    }
    if (report.convertedControls.length > 0) {
      console.info(`  converted: ${report.convertedControls.join(", ")}`);
    }
    for (const dropped of report.droppedControls) {
      console.info(`  dropped:   ${dropped.id} (${dropped.reason})`);
    }
  }
  if (reports.length === 0) console.info("No generated manifests found.");
  if (reports.some((report) => report.error)) process.exit(1);
}
