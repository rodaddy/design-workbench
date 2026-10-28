import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ComparisonRepository } from "../../src/client/components/compare/types";
import { comparisonSchema } from "../../src/client/components/compare/types";
import type {
  LibraryRepository,
  LibrarySnapshot,
} from "../../src/client/library/types";

const library: LibrarySnapshot = {
  inspirations: [],
  categories: [],
  briefs: [],
  captureTypes: [],
  sources: [],
  tags: [],
  systemStatus: "ready",
  statusMessage: "Library ready.",
};

function comparison(id: string) {
  return comparisonSchema.parse({
    id,
    slug: id,
    title: `Comparison ${id.toUpperCase()}`,
    sourceBriefId: null,
    status: "draft",
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
    directions: [
      {
        id: `direction-${id}`,
        position: 0,
        slug: `direction-${id}`,
        title: `Direction ${id.toUpperCase()}`,
        metadata: {},
        createdAt: "2026-07-24T12:00:00.000Z",
        variants: [],
      },
    ],
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

let browserWindow: Window;
let ComparePage: (typeof import("../../src/client/pages/ComparePage"))["ComparePage"];
let act: (typeof import("@testing-library/react/pure"))["act"];
let cleanup: (typeof import("@testing-library/react/pure"))["cleanup"];
let render: (typeof import("@testing-library/react/pure"))["render"];

beforeAll(async () => {
  browserWindow = new Window({ url: "http://localhost/compare/a" });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: browserWindow },
    document: { configurable: true, value: browserWindow.document },
    navigator: { configurable: true, value: browserWindow.navigator },
    HTMLElement: { configurable: true, value: browserWindow.HTMLElement },
  });

  ({ ComparePage } = await import("../../src/client/pages/ComparePage"));
  ({ act, cleanup, render } = await import("@testing-library/react/pure"));
});

afterAll(() => {
  cleanup();
  browserWindow.close();
});

describe("Compare page observable routing behavior", () => {
  test("does not let a stale route request overwrite the current workspace", async () => {
    const requests = {
      a: deferred<ReturnType<typeof comparison>>(),
      b: deferred<ReturnType<typeof comparison>>(),
    };
    const comparisonRepository: ComparisonRepository = {
      async list() {
        return [];
      },
      get(identifier) {
        return requests[identifier as keyof typeof requests].promise;
      },
      async create() {
        throw new Error("Not used by this test.");
      },
    };
    const libraryRepository = {
      async load() {
        return library;
      },
    } as LibraryRepository;
    const props = {
      library,
      libraryRepository,
      comparisonRepository,
      refreshLibrary: async () => {},
      variantOrigin: "http://127.0.0.1:3001",
      trustedOrigin: "http://localhost",
      navigate: () => {},
    };
    const view = render(<ComparePage {...props} pathname="/compare/a" />);

    view.rerender(<ComparePage {...props} pathname="/compare/b" />);
    await act(async () => requests.b.resolve(comparison("b")));
    expect(
      await view.findByRole("heading", { level: 1, name: "Comparison B" }),
    ).toBeTruthy();

    await act(async () => requests.a.resolve(comparison("a")));
    expect(
      view.getByRole("heading", { level: 1, name: "Comparison B" }),
    ).toBeTruthy();
    expect(
      view.queryByRole("heading", { level: 1, name: "Comparison A" }),
    ).toBeNull();
  });
});
