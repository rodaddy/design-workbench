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
import type { GenerationJob } from "../../src/client/studio/types";

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

function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: "job-1",
    projectId: "project-1",
    roundId: "round-1",
    comparisonId: "comparison-five",
    directionId: "direction-1",
    kind: "wide-net",
    engine: "impeccable",
    position: 0,
    status: "queued",
    cancelRequested: false,
    artifactPath: null,
    variantId: null,
    sessionId: null,
    runId: null,
    prompt: "",
    payload: {},
    error: null,
    attempts: 0,
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

/** A repository stub whose job methods are the ones under test. */
function repository(
  overrides: Partial<StudioRepository> = {},
): StudioRepository {
  return {
    listJobs: async () => [],
    enqueueMissingProofs: async () => [],
    cancelJob: async () => job(),
    ...overrides,
  } as unknown as StudioRepository;
}

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

describe("generation queue panel", () => {
  test("enqueues the missing proofs instead of blocking on one long request", async () => {
    const enqueued: string[] = [];
    const view = render(
      <CompareWorkspace
        comparison={comparison}
        variantOrigin="http://127.0.0.1:3001"
        trustedOrigin="http://localhost"
        navigate={() => {}}
        studioRepository={repository({
          enqueueMissingProofs: async (comparisonId: string) => {
            enqueued.push(comparisonId);
            return [job({ status: "queued" })];
          },
        })}
      />,
    );

    fireEvent.click(
      view.getByRole("button", { name: "Generate all missing proofs" }),
    );

    await waitFor(() => {
      expect(enqueued).toEqual(["comparison-five"]);
      // The operator is told what was queued rather than watching a spinner.
      expect(view.getByText(/Queued 10 proof generations/)).toBeTruthy();
    });
  });

  test("renders each job's state, target, and engine", async () => {
    const view = render(
      <CompareWorkspace
        comparison={comparison}
        variantOrigin="http://127.0.0.1:3001"
        trustedOrigin="http://localhost"
        navigate={() => {}}
        studioRepository={repository({
          listJobs: async () => [
            job({ id: "a", status: "running", directionId: "direction-1" }),
            job({
              id: "b",
              status: "completed",
              engine: "taste",
              directionId: "direction-2",
            }),
          ],
        })}
      />,
    );

    await waitFor(() => {
      expect(view.getByText("Running")).toBeTruthy();
      expect(view.getByText("Done")).toBeTruthy();
      expect(view.getByText("V1 Direction 1")).toBeTruthy();
      expect(view.getByText("V2 Direction 2")).toBeTruthy();
    });
  });

  test("surfaces a failed job's error rather than hiding it", async () => {
    const view = render(
      <CompareWorkspace
        comparison={comparison}
        variantOrigin="http://127.0.0.1:3001"
        trustedOrigin="http://localhost"
        navigate={() => {}}
        studioRepository={repository({
          listJobs: async () => [
            job({
              id: "c",
              status: "failed",
              error: "Generated workbench.json is invalid",
              startedAt: "2026-07-24T12:00:00.000Z",
              finishedAt: "2026-07-24T12:01:00.000Z",
            }),
          ],
        })}
      />,
    );

    await waitFor(() => {
      expect(view.getByText("Failed")).toBeTruthy();
      expect(
        view.getByText(/Generated workbench.json is invalid/),
      ).toBeTruthy();
    });
  });

  test("cancels a live job through the queue", async () => {
    const cancelled: string[] = [];
    const view = render(
      <CompareWorkspace
        comparison={comparison}
        variantOrigin="http://127.0.0.1:3001"
        trustedOrigin="http://localhost"
        navigate={() => {}}
        studioRepository={repository({
          listJobs: async () => [job({ id: "live", status: "running" })],
          cancelJob: async (jobId: string) => {
            cancelled.push(jobId);
            return job({ id: jobId, status: "cancelled" });
          },
        })}
      />,
    );

    const cancel = await waitFor(() =>
      view.getByRole("button", { name: "Cancel" }),
    );
    fireEvent.click(cancel);

    await waitFor(() => expect(cancelled).toEqual(["live"]));
  });

  test("offers no cancel control for a settled job", async () => {
    const view = render(
      <CompareWorkspace
        comparison={comparison}
        variantOrigin="http://127.0.0.1:3001"
        trustedOrigin="http://localhost"
        navigate={() => {}}
        studioRepository={repository({
          listJobs: async () => [job({ id: "done", status: "completed" })],
        })}
      />,
    );

    await waitFor(() => expect(view.getByText("Done")).toBeTruthy());
    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
