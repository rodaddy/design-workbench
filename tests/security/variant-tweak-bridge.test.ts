import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  createVariantFetchHandler,
  VARIANT_TWEAK_BRIDGE_PATH,
} from "../../src/server/variant-server";
import {
  WORKBENCH_TWEAK_PROTOCOL,
  WORKBENCH_TWEAK_VERSION,
} from "../../src/shared/tweaks";

const fixtureRoot = resolve(import.meta.dir, "../fixtures/variants");
const trustedOrigin = "http://127.0.0.1:4173";
const handler = createVariantFetchHandler({
  generatedVariantsRoot: fixtureRoot,
  trustedOrigin,
  hostname: "127.0.0.1",
  port: 41_874,
});

type MessageEventLike = {
  data: unknown;
  origin: string;
  source: object;
};

type MotionPreference = {
  matches: boolean;
  addEventListener: (type: "change", listener: () => void) => void;
};

let bridgeSource = "";

beforeAll(async () => {
  const response = await handler(
    new Request(
      `http://127.0.0.1:41874${VARIANT_TWEAK_BRIDGE_PATH}?variant=example`,
    ),
  );
  bridgeSource = await response.text();
});

function bridgeHarness(reducedMotion = false) {
  const parent = {};
  const writes = new Map<string, string>();
  const removals: string[] = [];
  let onMessage: ((event: MessageEventLike) => void) | undefined;
  let onMotionChange: (() => void) | undefined;
  const motionPreference: MotionPreference = {
    matches: reducedMotion,
    addEventListener: (_type, listener) => {
      onMotionChange = listener;
    },
  };
  const windowLike = {
    parent,
    matchMedia: () => motionPreference,
    addEventListener: (
      type: string,
      listener: (event: MessageEventLike) => void,
    ) => {
      if (type === "message") onMessage = listener;
    },
  };
  const documentLike = {
    documentElement: {
      style: {
        setProperty: (property: string, value: string) => {
          writes.set(property, value);
        },
        removeProperty: (property: string) => {
          writes.delete(property);
          removals.push(property);
        },
      },
    },
  };

  Function("window", "document", bridgeSource)(windowLike, documentLike);
  if (!onMessage) throw new Error("Bridge did not register a message listener");

  return {
    dispatch: onMessage,
    motionPreference,
    parent,
    removals,
    syncMotion: () => onMotionChange?.(),
    writes,
  };
}

function message(controlId: string, value: unknown) {
  return {
    type: WORKBENCH_TWEAK_PROTOCOL,
    version: WORKBENCH_TWEAK_VERSION,
    variantId: "example",
    controlId,
    value,
  };
}

describe("variant tweak bridge security", () => {
  test("applies each declared control through CSS custom properties only", () => {
    const harness = bridgeHarness();

    for (const [controlId, value] of [
      ["density", "compact"],
      ["scale", 1.25],
      ["accent", "#112233"],
      ["animate", true],
    ] as const) {
      harness.dispatch({
        source: harness.parent,
        origin: trustedOrigin,
        data: message(controlId, value),
      });
    }

    expect(Object.fromEntries(harness.writes)).toEqual({
      "--fixture-density": "compact",
      "--fixture-scale": "1.25",
      "--fixture-accent": "#112233",
      "--fixture-animate": "1",
    });
  });

  test("ignores untrusted origins, non-parent sources, and wrong variant identities", () => {
    const harness = bridgeHarness();
    const valid = message("accent", "#112233");

    harness.dispatch({
      source: harness.parent,
      origin: "https://example.com",
      data: valid,
    });
    harness.dispatch({
      source: {},
      origin: trustedOrigin,
      data: valid,
    });
    harness.dispatch({
      source: harness.parent,
      origin: trustedOrigin,
      data: { ...valid, variantId: "another-variant" },
    });

    expect(harness.writes.size).toBe(0);
  });

  test("refuses undeclared controls, extra capabilities, and invalid values", () => {
    const harness = bridgeHarness();
    const rejected = [
      message("unknown", "compact"),
      message("density", "body{color:red}"),
      message("scale", 1.1),
      message("scale", 99),
      message("accent", "red; background: url(https://example.com)"),
      {
        ...message("accent", "#112233"),
        selector: "body",
        css: "*{}",
        html: "<script></script>",
        js: "alert(1)",
      },
    ];

    for (const data of rejected) {
      harness.dispatch({
        source: harness.parent,
        origin: trustedOrigin,
        data,
      });
    }

    expect(harness.writes.size).toBe(0);
    expect(bridgeSource).not.toMatch(
      /\b(?:eval|innerHTML|outerHTML|insertRule|querySelector)\b/,
    );
  });

  test("suppresses and removes motion-affecting overrides while reduced motion is active", () => {
    const harness = bridgeHarness(true);
    harness.dispatch({
      source: harness.parent,
      origin: trustedOrigin,
      data: message("animate", true),
    });

    expect(harness.writes.has("--fixture-animate")).toBe(false);
    expect(harness.removals).toContain("--fixture-animate");

    harness.motionPreference.matches = false;
    harness.syncMotion();
    expect(harness.writes.get("--fixture-animate")).toBe("1");

    harness.motionPreference.matches = true;
    harness.syncMotion();
    expect(harness.writes.has("--fixture-animate")).toBe(false);
  });
});
