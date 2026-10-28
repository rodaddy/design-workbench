import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createWorkbenchTweakMessage,
  createWorkbenchTweakMessages,
} from "../../src/client/components/compare/tweaks";
import {
  parseWorkbenchTweakValue,
  workbenchTweakManifestSchema,
  workbenchTweakMessageSchema,
  WORKBENCH_TWEAK_PROTOCOL,
  WORKBENCH_TWEAK_VERSION,
} from "../../src/shared/tweaks";

const fixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../fixtures/variants/example/workbench.json"),
    "utf8",
  ),
);

describe("workbench tweak schemas", () => {
  test("parses the versioned fixture and all supported control types", () => {
    const manifest = workbenchTweakManifestSchema.parse(fixture);

    expect(manifest.version).toBe(WORKBENCH_TWEAK_VERSION);
    expect(manifest.variantId).toBe("example");
    expect(manifest.controls.map((control) => control.type)).toEqual([
      "choice",
      "number",
      "color",
      "boolean",
    ]);
    expect(manifest.controls[0]?.affectsMotion).toBe(false);
    expect(manifest.controls[3]?.affectsMotion).toBe(true);
  });

  test.each([
    ["property", "body"],
    ["property", "--safe; color: red"],
    ["variantId", "../example"],
    ["version", 2],
  ] as const)("rejects an unsafe %s value", (field, value) => {
    const unsafe = structuredClone(fixture);
    if (field === "property") {
      unsafe.controls[0].property = value;
    } else {
      unsafe[field] = value;
    }

    expect(workbenchTweakManifestSchema.safeParse(unsafe).success).toBe(false);
  });

  test("rejects raw CSS choice values and duplicate custom properties", () => {
    const unsafeChoice = structuredClone(fixture);
    unsafeChoice.controls[0].options[0].value = "url(https://example.com)";
    expect(workbenchTweakManifestSchema.safeParse(unsafeChoice).success).toBe(
      false,
    );

    const duplicateProperty = structuredClone(fixture);
    duplicateProperty.controls[1].property =
      duplicateProperty.controls[0].property;
    expect(
      workbenchTweakManifestSchema.safeParse(duplicateProperty).success,
    ).toBe(false);
  });

  test("validates values against the selected control instead of a raw CSS channel", () => {
    const manifest = workbenchTweakManifestSchema.parse(fixture);
    const scale = manifest.controls[1];
    const accent = manifest.controls[2];
    expect(scale).toBeDefined();
    expect(accent).toBeDefined();
    if (!scale || !accent) return;

    expect(parseWorkbenchTweakValue(scale, 1.25)).toBe(1.25);
    expect(() => parseWorkbenchTweakValue(scale, 1.1)).toThrow();
    expect(() => parseWorkbenchTweakValue(scale, 3)).toThrow();
    expect(parseWorkbenchTweakValue(accent, "#112233")).toBe("#112233");
    expect(() =>
      parseWorkbenchTweakValue(accent, "red; background: url(x)"),
    ).toThrow();
  });

  test("constructs strict identity-bound parent messages", () => {
    expect(createWorkbenchTweakMessage(fixture, "density", "compact")).toEqual({
      type: WORKBENCH_TWEAK_PROTOCOL,
      version: WORKBENCH_TWEAK_VERSION,
      variantId: "example",
      controlId: "density",
      value: "compact",
    });
    expect(
      createWorkbenchTweakMessages(fixture, {
        scale: 1.5,
        accent: "#123456",
      }),
    ).toHaveLength(2);

    expect(() =>
      createWorkbenchTweakMessage(fixture, "density", "raw-css"),
    ).toThrow();
    expect(() => createWorkbenchTweakMessage(fixture, "unknown", true)).toThrow(
      "Unknown workbench tweak control",
    );
  });

  test("message schema refuses selector, CSS, HTML, and JS extension fields", () => {
    const base = createWorkbenchTweakMessage(fixture, "animate", true);
    for (const field of ["selector", "css", "html", "js"]) {
      expect(
        workbenchTweakMessageSchema.safeParse({
          ...base,
          [field]: "body",
        }).success,
      ).toBe(false);
    }
  });
});
