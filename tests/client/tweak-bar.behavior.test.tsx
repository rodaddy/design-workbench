import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
// Aliased: happy-dom's Window would otherwise shadow the DOM lib's Window,
// which is the type TweakBar's targetWindow prop actually expects.
import { Window as HappyDomWindow } from "happy-dom";

/**
 * The tweak dock's live controls work entirely inside the frame, but saving,
 * restoring, and applying decisions are server round trips. These cover the
 * boundary: that the dock talks to the trusted workbench origin, that a
 * restore pushes the stored values back into the frame, and that a failure is
 * reported rather than swallowed.
 */

const MANIFEST = {
  version: 1,
  variantId: "comparison/direction-1/taste",
  controls: [
    {
      id: "paper",
      label: "Paper",
      property: "--paper",
      type: "color",
      affectsMotion: false,
      default: "#f1ebdc",
    },
    {
      id: "page-margin",
      label: "Page margin",
      property: "--page-margin",
      type: "number",
      affectsMotion: false,
      min: 1,
      max: 4,
      step: 0.25,
      unit: "rem",
      default: 2,
    },
  ],
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

let browserWindow: HappyDomWindow;
let TweakBar: (typeof import("../../src/client/studio/TweakBar"))["TweakBar"];
let cleanup: (typeof import("@testing-library/react/pure"))["cleanup"];
let fireEvent: (typeof import("@testing-library/react/pure"))["fireEvent"];
let render: (typeof import("@testing-library/react/pure"))["render"];
let waitFor: (typeof import("@testing-library/react/pure"))["waitFor"];

let calls: Call[] = [];
let posted: unknown[] = [];

/** Route fetches by path so each test only states the responses it cares about. */
function stubFetch(routes: Record<string, () => unknown>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const key = Object.keys(routes).find((path) => url.includes(path));
    if (!key) return new Response("null", { status: 404 });
    const value = routes[key]?.();
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/**
 * Stands in for the sandboxed variant frame. Only postMessage is exercised,
 * so a full Window is unnecessary.
 */
const targetWindow = {
  postMessage: (message: unknown) => posted.push(message),
} as unknown as Window;

beforeAll(async () => {
  browserWindow = new HappyDomWindow({ url: "http://localhost/compare/x" });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: browserWindow },
    document: { configurable: true, value: browserWindow.document },
    navigator: { configurable: true, value: browserWindow.navigator },
    HTMLElement: { configurable: true, value: browserWindow.HTMLElement },
  });
  ({ TweakBar } = await import("../../src/client/studio/TweakBar"));
  ({ cleanup, fireEvent, render, waitFor } =
    await import("@testing-library/react/pure"));
});

afterAll(() => {
  cleanup();
  browserWindow.close();
});

beforeEach(() => {
  cleanup();
  calls = [];
  posted = [];
});

function dock() {
  return (
    <TweakBar
      artifactPath="comparison/direction-1/taste"
      variantId="variant-1"
      variantOrigin="http://127.0.0.1:3001"
      targetWindow={targetWindow}
    />
  );
}

describe("tweak dock decision persistence", () => {
  test("saves decisions to the trusted origin, not the variant origin", async () => {
    stubFetch({
      "workbench.json": () => MANIFEST,
      "/api/variants/variant-1/tweak-decisions": () => [],
    });
    const view = render(dock());

    await waitFor(() => {
      expect(view.getByText("Tweaks")).toBeTruthy();
    });
    fireEvent.click(view.getByText("Tweaks"));
    await waitFor(() => {
      expect(view.getByText("Save decisions")).toBeTruthy();
    });

    fireEvent.change(view.getByPlaceholderText("Quieter hero"), {
      target: { value: "Quieter hero" },
    });
    fireEvent.click(view.getByText("Save decisions"));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST")).toBe(true);
    });
    const save = calls.find((call) => call.method === "POST");
    // A relative path keeps the request on the workbench origin. Posting
    // decisions to the untrusted variant origin would hand operator intent to
    // the generated page.
    expect(save?.url.startsWith("/api/")).toBe(true);
    expect(save?.url).toContain("/api/variants/variant-1/tweak-decisions");
    const body = save?.body as { label: string; idempotencyKey: string };
    expect(body.label).toBe("Quieter hero");
    expect(body.idempotencyKey.length).toBeGreaterThan(0);
  });

  test("restoring pushes the stored values back into the frame", async () => {
    stubFetch({
      "workbench.json": () => MANIFEST,
      "/api/variants/variant-1/tweak-decisions": () => [
        {
          id: "decision-1",
          label: "Quieter hero",
          createdAt: "2026-07-24T12:00:00.000Z",
          decisions: { "page-margin": 3.5 },
        },
      ],
      "/api/tweak-decisions/decision-1": () => ({
        decisionSet: { id: "decision-1" },
        manifest: MANIFEST,
        decisions: { "page-margin": 3.5 },
      }),
    });
    const view = render(dock());

    await waitFor(() => expect(view.getByText("Tweaks")).toBeTruthy());
    fireEvent.click(view.getByText("Tweaks"));
    await waitFor(() => expect(view.getByText("Restore")).toBeTruthy());

    posted = [];
    fireEvent.click(view.getByText("Restore"));

    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const message = posted.at(-1) as {
      type: string;
      controlId: string;
      value: number;
    };
    expect(message.controlId).toBe("page-margin");
    expect(message.value).toBe(3.5);
  });

  test("reports a rejected restore rather than applying stale values", async () => {
    stubFetch({
      "workbench.json": () => MANIFEST,
      "/api/variants/variant-1/tweak-decisions": () => [
        {
          id: "decision-1",
          label: "Stale",
          createdAt: "2026-07-24T12:00:00.000Z",
          decisions: {},
        },
      ],
      "/api/tweak-decisions/decision-1": () =>
        new Response(
          JSON.stringify({
            message: "Unknown tweak control 'page-margin' for this variant",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });
    const view = render(dock());

    await waitFor(() => expect(view.getByText("Tweaks")).toBeTruthy());
    fireEvent.click(view.getByText("Tweaks"));
    await waitFor(() => expect(view.getByText("Restore")).toBeTruthy());

    posted = [];
    fireEvent.click(view.getByText("Restore"));

    await waitFor(() => {
      expect(view.getByText(/Unknown tweak control/)).toBeTruthy();
    });
    // The frame must be left exactly as the operator had it.
    expect(posted).toHaveLength(0);
  });

  test("asking the agent to apply targets the revision route", async () => {
    stubFetch({
      "workbench.json": () => MANIFEST,
      "/api/variants/variant-1/tweak-decisions": () => [
        {
          id: "decision-1",
          label: "Quieter hero",
          createdAt: "2026-07-24T12:00:00.000Z",
          decisions: { "page-margin": 3.5 },
        },
      ],
      "/api/tweak-decisions/decision-1/apply": () => ({
        id: "revision-1",
        status: "completed",
      }),
    });
    const view = render(dock());

    await waitFor(() => expect(view.getByText("Tweaks")).toBeTruthy());
    fireEvent.click(view.getByText("Tweaks"));
    await waitFor(() =>
      expect(view.getByText("Ask agent to apply")).toBeTruthy(),
    );

    fireEvent.click(view.getByText("Ask agent to apply"));

    await waitFor(() => {
      expect(
        calls.some(
          (call) => call.url.includes("/apply") && call.method === "POST",
        ),
      ).toBe(true);
    });
  });
});
