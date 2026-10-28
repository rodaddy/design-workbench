import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import type { ComparisonVariant } from "../../src/client/components/compare/types";

const variant: ComparisonVariant = {
  id: "variant-impeccable",
  engine: "impeccable",
  artifactPath: "comparison-one/direction-one/impeccable",
  viewport: {},
  metadata: {},
  createdAt: "2026-07-24T12:00:00.000Z",
  updatedAt: "2026-07-24T12:00:00.000Z",
};

const replacementVariant: ComparisonVariant = {
  ...variant,
  id: "variant-replacement",
  artifactPath: "comparison-one/direction-two/impeccable",
};

function manifestFor(variantId: string) {
  return {
    version: 1,
    variantId,
    controls: [
      {
        id: "strong-type",
        label: "Strong type",
        property: "--strong-type",
        type: "boolean",
        default: false,
        affectsMotion: false,
      },
    ],
  };
}

let browserWindow: HappyWindow;
let VariantPanel: (typeof import("../../src/client/components/compare/VariantPanel"))["VariantPanel"];
let cleanup: (typeof import("@testing-library/react/pure"))["cleanup"];
let fireEvent: (typeof import("@testing-library/react/pure"))["fireEvent"];
let render: (typeof import("@testing-library/react/pure"))["render"];

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  browserWindow = new HappyWindow({
    url: "http://localhost/compare/comparison-one",
  });
  const iframeWindows = new WeakMap<HTMLIFrameElement, Window>();
  Object.defineProperty(
    browserWindow.HTMLIFrameElement.prototype,
    "contentWindow",
    {
      configurable: true,
      get(this: HTMLIFrameElement) {
        const existing = iframeWindows.get(this);
        if (existing) return existing;
        const next = { postMessage() {} } as unknown as Window;
        iframeWindows.set(this, next);
        return next;
      },
    },
  );
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: browserWindow },
    document: { configurable: true, value: browserWindow.document },
    navigator: { configurable: true, value: browserWindow.navigator },
    HTMLElement: { configurable: true, value: browserWindow.HTMLElement },
    HTMLIFrameElement: {
      configurable: true,
      value: browserWindow.HTMLIFrameElement,
    },
    fetch: {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        return url.endsWith("/workbench.json")
          ? Response.json(
              manifestFor(
                url.includes("/direction-two/")
                  ? replacementVariant.artifactPath
                  : variant.artifactPath,
              ),
            )
          : new Response(null, { status: 200 });
      },
    },
  });
  ({ VariantPanel } =
    await import("../../src/client/components/compare/VariantPanel"));
  ({ cleanup, fireEvent, render } =
    await import("@testing-library/react/pure"));
});

afterAll(() => {
  cleanup();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: originalFetch,
  });
  browserWindow.close();
});

beforeEach(() => {
  cleanup();
});

describe("VariantPanel iframe target lifecycle", () => {
  test("does not send tweaks to the previous iframe while a new viewport or source loads", async () => {
    const view = render(
      <VariantPanel
        engine="impeccable"
        directionTitle="Direction One"
        variant={variant}
        viewport="desktop"
        variantOrigin="http://127.0.0.1:3001"
        trustedOrigin="http://localhost"
      />,
    );
    const firstFrame = (await view.findByTitle(
      /Desktop viewport/,
    )) as HTMLIFrameElement;
    const firstWindow = firstFrame.contentWindow;
    if (!firstWindow) throw new Error("Initial iframe window was not created.");
    const firstPosted: unknown[] = [];
    Object.defineProperty(firstWindow, "postMessage", {
      configurable: true,
      value: (message: unknown) => firstPosted.push(message),
    });

    fireEvent.load(firstFrame);
    fireEvent.click(await view.findByRole("button", { name: "Tweaks" }));
    fireEvent.click(view.getByRole("checkbox", { name: "Strong type" }));
    expect(firstPosted).toHaveLength(1);

    view.rerender(
      <VariantPanel
        engine="impeccable"
        directionTitle="Direction One"
        variant={variant}
        viewport="tablet"
        variantOrigin="http://127.0.0.1:3001"
        trustedOrigin="http://localhost"
      />,
    );
    const tabletFrame = (await view.findByTitle(
      /Tablet viewport/,
    )) as HTMLIFrameElement;
    fireEvent.click(await view.findByRole("button", { name: "Tweaks" }));
    fireEvent.click(view.getByRole("checkbox", { name: "Strong type" }));
    expect(firstPosted).toHaveLength(1);

    const tabletWindow = tabletFrame.contentWindow;
    if (!tabletWindow) throw new Error("Tablet iframe window was not created.");
    const tabletPosted: unknown[] = [];
    Object.defineProperty(tabletWindow, "postMessage", {
      configurable: true,
      value: (message: unknown) => tabletPosted.push(message),
    });
    fireEvent.load(tabletFrame);
    fireEvent.click(view.getByRole("checkbox", { name: "Strong type" }));
    expect(tabletPosted).toHaveLength(1);

    view.rerender(
      <VariantPanel
        engine="impeccable"
        directionTitle="Direction Two"
        variant={replacementVariant}
        viewport="tablet"
        variantOrigin="http://127.0.0.1:3001"
        trustedOrigin="http://localhost"
      />,
    );
    await view.findByTitle(/Direction Two at Tablet viewport/);
    fireEvent.click(await view.findByRole("button", { name: "Tweaks" }));
    fireEvent.click(view.getByRole("checkbox", { name: "Strong type" }));

    expect(tabletPosted).toHaveLength(1);
  });
});
