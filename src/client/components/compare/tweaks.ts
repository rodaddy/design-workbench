import {
  parseWorkbenchTweakValue,
  workbenchTweakManifestSchema,
  workbenchTweakMessageSchema,
  WORKBENCH_TWEAK_PROTOCOL,
  WORKBENCH_TWEAK_VERSION,
  type WorkbenchTweakManifest,
  type WorkbenchTweakMessage,
} from "../../../shared/tweaks";

function controlForId(manifest: WorkbenchTweakManifest, controlId: string) {
  const control = manifest.controls.find(
    (candidate) => candidate.id === controlId,
  );
  if (!control) {
    throw new TypeError(`Unknown workbench tweak control: ${controlId}`);
  }
  return control;
}

export function createWorkbenchTweakMessage(
  manifestInput: unknown,
  controlId: string,
  value: unknown,
): WorkbenchTweakMessage {
  const manifest = workbenchTweakManifestSchema.parse(manifestInput);
  const control = controlForId(manifest, controlId);

  return workbenchTweakMessageSchema.parse({
    type: WORKBENCH_TWEAK_PROTOCOL,
    version: WORKBENCH_TWEAK_VERSION,
    variantId: manifest.variantId,
    controlId: control.id,
    value: parseWorkbenchTweakValue(control, value),
  });
}

export function createWorkbenchTweakMessages(
  manifestInput: unknown,
  values: Readonly<Record<string, unknown>>,
): WorkbenchTweakMessage[] {
  const manifest = workbenchTweakManifestSchema.parse(manifestInput);
  return Object.entries(values).map(([controlId, value]) =>
    createWorkbenchTweakMessage(manifest, controlId, value),
  );
}
