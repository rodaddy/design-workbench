import { describe, expect, test } from "bun:test";
import {
  normalizeWorkbenchTweakManifest,
  WorkbenchManifestNormalizationError,
  workbenchTweakManifestSchema,
} from "../../src/shared/tweaks";

const VARIANT_ID = "89ba554b/direction-1/impeccable";

/**
 * Both fixtures below are the manifests two real local generation runs actually
 * produced. They are the exact shapes that registered successfully and then
 * made the variant server answer 500, so they are the regression floor for the
 * generated-artifact contract.
 */
const OBSERVED_IMPECCABLE_MANIFEST = {
  version: 1,
  name: "rTech — Print Tech / Paper proof sheets",
  target: "assets/site.css",
  tweaks: [
    {
      id: "paper-stock",
      label: "Paper stock",
      cssCustomProperty: "--paper",
      type: "color",
      value: "#f1ebdc",
      decision: "Warm uncoated stock keeps the directions in one world.",
    },
    {
      id: "registration-ink",
      label: "Registration ink",
      cssCustomProperty: "--ink",
      type: "color",
      value: "#171713",
      decision: "Near-black ink supports print authority.",
    },
  ],
};

const OBSERVED_TASTE_MANIFEST = {
  version: 1,
  name: "Taste Direction 01 - Print Tech / Paper",
  target: "assets/site.css",
  scope: ".home",
  tweaks: [
    {
      id: "paper-stock",
      label: "Paper stock",
      type: "color",
      property: "--paper-stock",
      value: "#ece9df",
      decision: "A cool recycled-paper neutral keeps the page print-like.",
    },
  ],
};

describe("generated tweak manifest normalization", () => {
  test("normalizes the observed Impeccable manifest into a servable one", () => {
    const manifest = normalizeWorkbenchTweakManifest(
      OBSERVED_IMPECCABLE_MANIFEST,
      VARIANT_ID,
    );

    expect(manifest.variantId).toBe(VARIANT_ID);
    expect(manifest.controls).toHaveLength(2);
    const [paper] = manifest.controls;
    expect(paper?.property).toBe("--paper");
    expect(paper?.type).toBe("color");
    if (paper?.type === "color") expect(paper.default).toBe("#f1ebdc");
    // The result must satisfy the same schema the variant server enforces.
    expect(() => workbenchTweakManifestSchema.parse(manifest)).not.toThrow();
  });

  test("normalizes the observed Taste manifest, which already used 'property'", () => {
    const manifest = normalizeWorkbenchTweakManifest(
      OBSERVED_TASTE_MANIFEST,
      "89ba554b/direction-1/taste",
    );

    expect(manifest.variantId).toBe("89ba554b/direction-1/taste");
    const [stock] = manifest.controls;
    expect(stock?.property).toBe("--paper-stock");
    if (stock?.type === "color") expect(stock.default).toBe("#ece9df");
    expect(() => workbenchTweakManifestSchema.parse(manifest)).not.toThrow();
  });

  test("drops generator-only rationale fields rather than failing strict parsing", () => {
    const manifest = normalizeWorkbenchTweakManifest(
      OBSERVED_TASTE_MANIFEST,
      VARIANT_ID,
    );
    expect(manifest.controls[0]).not.toHaveProperty("decision");
    expect(manifest.controls[0]).not.toHaveProperty("value");
  });

  test("widens shorthand choice options into label/value pairs", () => {
    // Observed live: a wide-net proof was rejected outright because its
    // display-weight control listed options as bare strings.
    const manifest = normalizeWorkbenchTweakManifest(
      {
        version: 1,
        controls: [
          {
            id: "display-weight",
            label: "Display weight",
            property: "--display-weight",
            type: "choice",
            options: ["400", "500", "600", "700"],
            default: "600",
          },
        ],
      },
      VARIANT_ID,
    );

    const [weight] = manifest.controls;
    expect(weight?.type).toBe("choice");
    if (weight?.type === "choice") {
      expect(weight.options).toEqual([
        { label: "400", value: "400" },
        { label: "500", value: "500" },
        { label: "600", value: "600" },
        { label: "700", value: "700" },
      ]);
      expect(weight.default).toBe("600");
    }
    expect(() => workbenchTweakManifestSchema.parse(manifest)).not.toThrow();
  });

  test("snaps a number default onto the declared step grid", () => {
    // Observed live: a proof was discarded because hero-veil defaulted to 0.62
    // on a 0.35 min with a 0.02 step, which only reaches 0.61 or 0.63.
    const manifest = normalizeWorkbenchTweakManifest(
      {
        version: 1,
        controls: [
          {
            id: "hero-veil",
            label: "Hero veil strength",
            property: "--hero-veil",
            type: "number",
            min: 0.35,
            max: 1,
            step: 0.02,
            unit: "",
            default: 0.62,
          },
        ],
      },
      VARIANT_ID,
    );

    const [veil] = manifest.controls;
    if (veil?.type === "number") expect(veil.default).toBe(0.63);
    expect(() => workbenchTweakManifestSchema.parse(manifest)).not.toThrow();
  });

  test("leaves an out-of-range default to fail rather than snapping it into bounds", () => {
    // A default outside min..max is a disagreement about the control's bounds,
    // not a rounding artifact, so it must not be quietly clamped.
    expect(() =>
      normalizeWorkbenchTweakManifest(
        {
          version: 1,
          controls: [
            {
              id: "page-margin",
              label: "Page margin",
              property: "--page-margin",
              type: "number",
              min: 1,
              max: 4,
              step: 0.5,
              unit: "rem",
              default: 9,
            },
          ],
        },
        VARIANT_ID,
      ),
    ).toThrow();
  });

  test("rejects the unsupported 'length' control instead of guessing a number", () => {
    let caught: unknown;
    try {
      normalizeWorkbenchTweakManifest(
        {
          version: 1,
          tweaks: [
            {
              id: "page-gutter",
              label: "Workbench gutter",
              cssCustomProperty: "--gutter",
              type: "length",
              value: "clamp(1rem, 3.2vw, 3.5rem)",
            },
          ],
        },
        VARIANT_ID,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WorkbenchManifestNormalizationError);
    expect((caught as WorkbenchManifestNormalizationError).code).toBe(
      "MANIFEST_CONTROL_TYPE_UNSUPPORTED",
    );
  });

  test("binds the serving path and never trusts a generator-declared variantId", () => {
    const manifest = normalizeWorkbenchTweakManifest(
      {
        version: 1,
        variantId: "some/other/path",
        controls: [
          {
            id: "accent",
            label: "Accent",
            property: "--accent",
            type: "color",
            default: "#3366ff",
          },
        ],
      },
      VARIANT_ID,
    );
    expect(manifest.variantId).toBe(VARIANT_ID);
  });

  test("rejects a manifest with no controls array", () => {
    expect(() =>
      normalizeWorkbenchTweakManifest({ version: 1 }, VARIANT_ID),
    ).toThrow(WorkbenchManifestNormalizationError);
  });

  test("rejects a control whose property is not a CSS custom property", () => {
    expect(() =>
      normalizeWorkbenchTweakManifest(
        {
          version: 1,
          controls: [
            {
              id: "accent",
              label: "Accent",
              property: "color",
              type: "color",
              default: "#3366ff",
            },
          ],
        },
        VARIANT_ID,
      ),
    ).toThrow(WorkbenchManifestNormalizationError);
  });

  test("rejects a non-object manifest", () => {
    expect(() => normalizeWorkbenchTweakManifest([], VARIANT_ID)).toThrow(
      WorkbenchManifestNormalizationError,
    );
  });
});
