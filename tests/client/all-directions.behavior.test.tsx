import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Window } from "happy-dom";
import type { Comparison } from "../../src/client/components/compare/types";
import type { StudioRepository } from "../../src/client/studio/repository";

const comparison: Comparison = {
  id: "comparison-five",
  slug: "comparison-five",
  title: "Five Direction Proof",
  sourceBriefId: null,
  status: "draft",
  createdAt: "2026-07-24T12:00:00.000Z",
  updatedAt: "2026-07-24T12:00:00.000Z",
  directions: Array.from({ length: 5 }, (_, position) => ({
    id: `direction-${position + 1}`,
    position,
    slug: `direction-${position + 1}`,
    title: `Direction ${position + 1}`,
    metadata: { aestheticFamily: `Family ${position + 1}` },
    createdAt: "2026-07-24T12:00:00.000Z",
    variants: [],
  })),
};

let browserWindow: Window;
let CompareWorkspace: (typeof import("../../src/client/components/compare/CompareWorkspace"))["CompareWorkspace"];
let cleanup: (typeof import("@testing-library/react/pure"))["cleanup"];
let fireEvent: (typeof import("@testing-library/react/pure"))["fireEvent"];
let render: (typeof import("@testing-library/react/pure"))["render"];
let waitFor: (typeof import("@testing-library/react/pure"))["waitFor"];

beforeAll(async () => {
  browserWindow = new Window({
    url: "http://localhost/compare/comparison-five",
  });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: browserWindow },
    document: { configurable: true, value: browserWindow.document },
    navigator: { configurable: true, value: browserWindow.navigator },
    HTMLElement: { configurable: true, value: browserWindow.HTMLElement },
  });
  ({ CompareWorkspace } =
    await import("../../src/client/components/compare/CompareWorkspace"));
  ({ cleanup, fireEvent, render, waitFor } =
    await import("@testing-library/react/pure"));
});

afterAll(() => {
  cleanup();
  browserWindow.close();
});

beforeEach(() => {
  cleanup();
});

describe("five-direction comparison board", () => {
  test("shows all ten engine slots together and opens one paired direction", () => {
    const view = render(
      <CompareWorkspace
        comparison={comparison}
        variantOrigin="http://127.0.0.1:3001"
        trustedOrigin="http://localhost"
        navigate={() => {}}
      />,
    );

    expect(
      view.getByRole("tab", { name: /All 5/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(view.getByRole("heading", { name: "All directions" })).toBeTruthy();
    expect(view.getAllByText(/output is missing/)).toHaveLength(10);
    expect(
      view.getAllByRole("button", { name: /Open paired proof/ }),
    ).toHaveLength(5);
    for (let index = 1; index <= 5; index += 1) {
      expect(
        view.getAllByText(`Family ${index}`).length,
      ).toBeGreaterThanOrEqual(2);
    }

    fireEvent.click(view.getByRole("tab", { name: /V2 Family 2/ }));

    expect(view.queryByRole("heading", { name: "All directions" })).toBeNull();
    expect(view.getAllByText(/output is missing/)).toHaveLength(2);
    expect(
      view
        .getByRole("tab", { name: /V2 Family 2/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("creates three refinements only from a selected direction and returns to Studio", async () => {
    const calls: Array<[string, string]> = [];
    const navigations: string[] = [];
    const studioRepository = {
      createRefinement: async (comparisonId: string, directionId: string) => {
        calls.push([comparisonId, directionId]);
        return {};
      },
    } as unknown as StudioRepository;
    const view = render(
      <CompareWorkspace
        comparison={comparison}
        variantOrigin="http://127.0.0.1:3001"
        trustedOrigin="http://localhost"
        navigate={(path) => navigations.push(path)}
        studioRepository={studioRepository}
      />,
    );

    expect(
      view.queryByRole("button", {
        name: "Choose direction / Generate 3 refinements",
      }),
    ).toBeNull();
    fireEvent.click(view.getByRole("tab", { name: /V3 Family 3/ }));
    fireEvent.click(
      view.getByRole("button", {
        name: "Choose direction / Generate 3 refinements",
      }),
    );

    await waitFor(() => {
      expect(calls).toEqual([["comparison-five", "direction-3"]]);
      expect(navigations).toEqual(["/studio"]);
    });
  });
});
