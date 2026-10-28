import { z } from "zod";

export const WORKBENCH_TWEAK_PROTOCOL = "design-workbench:tweak";
export const WORKBENCH_TWEAK_VERSION = 1;

const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, "must be a lowercase kebab-case identifier");

export const workbenchVariantIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/,
    "must be a contained lowercase path",
  );

export const cssCustomPropertyNameSchema = z
  .string()
  .max(64)
  .regex(
    /^--[a-z][a-z0-9-]*$/,
    "must be an ASCII lowercase CSS custom property name",
  );

const labelSchema = z.string().trim().min(1).max(120);
const choiceValueSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "must be a single safe CSS token");
const colorValueSchema = z
  .string()
  .regex(
    /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/,
    "must be a 6 or 8 digit hex color",
  );

const controlBase = {
  id: identifierSchema,
  label: labelSchema,
  property: cssCustomPropertyNameSchema,
  affectsMotion: z.boolean().default(false),
};

const choiceControlSchema = z
  .object({
    ...controlBase,
    type: z.literal("choice"),
    options: z
      .array(
        z
          .object({
            label: labelSchema,
            value: choiceValueSchema,
          })
          .strict(),
      )
      .min(2)
      .max(32),
    default: choiceValueSchema,
  })
  .strict();

const numberControlSchema = z
  .object({
    ...controlBase,
    type: z.literal("number"),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().positive().default(1),
    unit: z.enum(["", "px", "rem", "em", "%", "deg", "ms", "s"]).default(""),
    default: z.number().finite(),
  })
  .strict();

const colorControlSchema = z
  .object({
    ...controlBase,
    type: z.literal("color"),
    default: colorValueSchema,
  })
  .strict();

const booleanControlSchema = z
  .object({
    ...controlBase,
    type: z.literal("boolean"),
    default: z.boolean(),
  })
  .strict();

function isStepAligned(value: number, min: number, step: number): boolean {
  const steps = (value - min) / step;
  return Math.abs(steps - Math.round(steps)) <= 1e-9;
}

export const workbenchTweakControlSchema = z
  .discriminatedUnion("type", [
    choiceControlSchema,
    numberControlSchema,
    colorControlSchema,
    booleanControlSchema,
  ])
  .superRefine((control, context) => {
    if (control.type === "choice") {
      const values = control.options.map((option) => option.value);
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: ["options"],
          message: "choice option values must be unique",
        });
      }
      if (!values.includes(control.default)) {
        context.addIssue({
          code: "custom",
          path: ["default"],
          message: "default must match a declared choice option",
        });
      }
    }

    if (control.type === "number") {
      if (control.min >= control.max) {
        context.addIssue({
          code: "custom",
          path: ["max"],
          message: "max must be greater than min",
        });
      }
      if (control.default < control.min || control.default > control.max) {
        context.addIssue({
          code: "custom",
          path: ["default"],
          message: "default must be within the declared bounds",
        });
      } else if (!isStepAligned(control.default, control.min, control.step)) {
        context.addIssue({
          code: "custom",
          path: ["default"],
          message: "default must align to the declared step",
        });
      }
    }
  });

export const workbenchTweakManifestSchema = z
  .object({
    version: z.literal(WORKBENCH_TWEAK_VERSION),
    variantId: workbenchVariantIdSchema,
    controls: z.array(workbenchTweakControlSchema).max(64),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = manifest.controls.map((control) => control.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["controls"],
        message: "control ids must be unique",
      });
    }

    const properties = manifest.controls.map((control) => control.property);
    if (new Set(properties).size !== properties.length) {
      context.addIssue({
        code: "custom",
        path: ["controls"],
        message: "control properties must be unique",
      });
    }
  });

export const workbenchTweakMessageSchema = z
  .object({
    type: z.literal(WORKBENCH_TWEAK_PROTOCOL),
    version: z.literal(WORKBENCH_TWEAK_VERSION),
    variantId: workbenchVariantIdSchema,
    controlId: identifierSchema,
    value: z.union([
      z.boolean(),
      z.number().finite(),
      choiceValueSchema,
      colorValueSchema,
    ]),
  })
  .strict();

export type WorkbenchTweakControl = z.infer<typeof workbenchTweakControlSchema>;
export type WorkbenchTweakManifest = z.infer<
  typeof workbenchTweakManifestSchema
>;
export type WorkbenchTweakMessage = z.infer<typeof workbenchTweakMessageSchema>;
export type WorkbenchTweakValue = WorkbenchTweakMessage["value"];

/**
 * Generated `workbench.json` files are authored by a local agent, so they
 * arrive in near-miss shapes: `tweaks` instead of `controls`,
 * `cssCustomProperty` instead of `property`, `value` instead of `default`, and
 * no `variantId` (the generator cannot know its own serving path). Normalizing
 * is deliberately limited to those deterministic renames plus injecting the
 * caller-supplied variantId. It never invents controls, never coerces a value
 * into a different type, and never rescues an unsupported control type — an
 * unsupported `length` control is a real authoring error the generator must fix,
 * not something the workbench should silently reinterpret as a number or drop.
 */
export class WorkbenchManifestNormalizationError extends Error {
  constructor(
    readonly code:
      | "MANIFEST_NOT_AN_OBJECT"
      | "MANIFEST_CONTROL_TYPE_UNSUPPORTED"
      | "MANIFEST_INVALID",
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = "WorkbenchManifestNormalizationError";
  }
}

/** Control types the tweak protocol can safely apply at runtime. */
export const SUPPORTED_TWEAK_CONTROL_TYPES = [
  "choice",
  "number",
  "color",
  "boolean",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deterministic, safe field aliases observed in real generated manifests. */
function normalizeControl(input: unknown, index: number): unknown {
  if (!isPlainObject(input)) {
    throw new WorkbenchManifestNormalizationError(
      "MANIFEST_INVALID",
      `Control at position ${index} is not an object`,
    );
  }

  const type = input.type;
  if (
    typeof type === "string" &&
    !SUPPORTED_TWEAK_CONTROL_TYPES.includes(
      type as (typeof SUPPORTED_TWEAK_CONTROL_TYPES)[number],
    )
  ) {
    throw new WorkbenchManifestNormalizationError(
      "MANIFEST_CONTROL_TYPE_UNSUPPORTED",
      `Control '${String(input.id ?? index)}' declares unsupported type '${type}'. Supported types are ${SUPPORTED_TWEAK_CONTROL_TYPES.join(", ")}.`,
    );
  }

  const control: Record<string, unknown> = { ...input };

  // `cssCustomProperty` is the most common generated alias for `property`.
  if (!("property" in control) && "cssCustomProperty" in control) {
    control.property = control.cssCustomProperty;
  }
  delete control.cssCustomProperty;

  // Generators describe the chosen value as `value`; the protocol calls the
  // starting value `default`.
  if (!("default" in control) && "value" in control) {
    control.default = control.value;
  }
  delete control.value;

  // `decision` is generator rationale, not part of the runtime contract. It is
  // preserved in the artifact file itself; the served manifest stays minimal.
  delete control.decision;

  // A choice option is {label, value}, but the shorthand ["400", "500"] is the
  // natural way to write a list and generators reach for it. The scalar already
  // is the value, and using it as the label too says what a hand-written
  // manifest would have said, so widen here rather than lose the whole proof.
  if (Array.isArray(control.options)) {
    control.options = control.options.map((option) =>
      typeof option === "string" || typeof option === "number"
        ? { label: String(option), value: String(option) }
        : option,
    );
  }

  // A generator picks the number it wants to see, then picks a step for the
  // slider; the two need not land on each other. Snapping the default to the
  // nearest step keeps the operator's starting point within half a step of the
  // intended value, which is a smaller loss than discarding the whole artifact
  // over arithmetic. Only an already-in-range default is snapped: one outside
  // min..max is a real disagreement about the control's bounds, not a rounding
  // artifact, and still fails.
  if (
    control.type === "number" &&
    typeof control.default === "number" &&
    typeof control.min === "number" &&
    typeof control.max === "number" &&
    typeof control.step === "number" &&
    control.step > 0 &&
    control.default >= control.min &&
    control.default <= control.max
  ) {
    const steps = Math.round((control.default - control.min) / control.step);
    const snapped = control.min + steps * control.step;
    // Re-round to the step's own precision so binary floating point does not
    // reintroduce the misalignment the snap just removed.
    const decimals = (String(control.step).split(".")[1] ?? "").length;
    control.default = Math.min(
      control.max,
      Number(snapped.toFixed(Math.max(decimals, 6))),
    );
  }

  return control;
}

/**
 * Normalize a generated manifest into the authoritative schema, binding it to
 * the variant path it will actually be served from. Throws
 * WorkbenchManifestNormalizationError when the manifest cannot be made valid
 * without guessing.
 */
export function normalizeWorkbenchTweakManifest(
  input: unknown,
  variantId: string,
): WorkbenchTweakManifest {
  const boundVariantId = workbenchVariantIdSchema.safeParse(variantId);
  if (!boundVariantId.success) {
    throw new WorkbenchManifestNormalizationError(
      "MANIFEST_INVALID",
      "Variant identity is invalid",
      boundVariantId.error.issues,
    );
  }
  if (!isPlainObject(input)) {
    throw new WorkbenchManifestNormalizationError(
      "MANIFEST_NOT_AN_OBJECT",
      "Tweak manifest must be a JSON object",
    );
  }

  const rawControls = Array.isArray(input.controls)
    ? input.controls
    : Array.isArray(input.tweaks)
      ? input.tweaks
      : undefined;
  if (rawControls === undefined) {
    throw new WorkbenchManifestNormalizationError(
      "MANIFEST_INVALID",
      "Tweak manifest must declare a 'controls' array",
    );
  }

  const candidate = {
    version: WORKBENCH_TWEAK_VERSION,
    // The serving path is authoritative; a generator-declared variantId is
    // always overridden rather than trusted.
    variantId: boundVariantId.data,
    controls: rawControls.map(normalizeControl),
  };

  const parsed = workbenchTweakManifestSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new WorkbenchManifestNormalizationError(
      "MANIFEST_INVALID",
      "Tweak manifest does not satisfy the workbench tweak schema",
      parsed.error.issues,
    );
  }
  return parsed.data;
}

export function parseWorkbenchTweakValue(
  control: WorkbenchTweakControl,
  input: unknown,
): WorkbenchTweakValue {
  switch (control.type) {
    case "choice":
      return z
        .enum(
          control.options.map((option) => option.value) as [
            string,
            ...string[],
          ],
        )
        .parse(input);
    case "number":
      return z
        .number()
        .finite()
        .min(control.min)
        .max(control.max)
        .refine(
          (value) => isStepAligned(value, control.min, control.step),
          "must align to the declared step",
        )
        .parse(input);
    case "color":
      return colorValueSchema.parse(input);
    case "boolean":
      return z.boolean().parse(input);
  }
}
