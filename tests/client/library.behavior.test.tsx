import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Window } from "happy-dom";
import type { RenderResult } from "@testing-library/react/pure";
import {
  API_CONTRACT_UNAVAILABLE,
  type BriefImport,
  type Category,
  type DesignBrief,
  type Inspiration,
  type InspirationDraft,
  type LibraryRepository,
  type LibrarySnapshot,
} from "../../src/client/library/types";

const REDSUN_TITLE = "RedSun AI Landing Page — Scroll-Lit Product Showcase";
const REDSUN_BRIEF =
  "Design a dark, cinematic landing page for a sophisticated software product. Build the hero around a centered, concise promise and one abstract luminous form that visually opens into a real product interface below. Use an almost-black palette, crisp white geometric sans type, charcoal glass panels, hairline borders, and one ember-warm accent reserved for primary actions and moments of emphasis. Create a calm scroll narrative: hero, product reveal, focused capability panels, then a three-column editorial image beat. Use soft directional light and restrained bloom to create depth while keeping text and controls accessible. Match the source’s premium, mysterious confidence without reusing its branding, imagery, copy, or planetary motif.";
const REDSUN_PROMPT =
  "Use one warm, luminous accent to guide attention through an otherwise monochrome page.";

const redSun: Inspiration = {
  id: "inspiration-red-sun",
  title: REDSUN_TITLE,
  sourceUrl: "https://www.pinterest.com/pin/844493676784201/",
  source: "Pinterest",
  purpose:
    "Showcase a dark AI landing page through scroll behavior and lighting treatment.",
  aestheticFamily: "Dark cinematic SaaS",
  vocabulary: [
    "near-black canvas",
    "ember-orange CTA glow",
    "luminous orbital arc",
    "centered oversized hero type",
    "frosted dark panels",
    "thin hairline borders",
    "three-up editorial cards",
    "layered dashboard mockups",
  ],
  tags: ["dark-saas", "cinematic-glow"],
  categoryIds: ["vast-quiet"],
  captureType: "public direct MP4",
  status: "captured",
  confidence: "high",
  composition:
    "A strongly axial hero leads into broad product panels and a balanced three-column rhythm.",
  typography: "Clean geometric sans serif with large centered hero type.",
  colorMaterial:
    "Black and charcoal with white type and a sparing saturated orange accent.",
  motion: "Scroll-led reveals and a moving light wash connect sections.",
  borrow:
    "Use one warm luminous accent and a hero object that bridges into product UI.",
  avoid:
    "Do not reproduce the RedSun identity, exact planetary arc, or dashboard screens.",
  limitation:
    "The evidence does not establish implementation details or every intermediate transition.",
  brief: REDSUN_BRIEF,
  prompt: REDSUN_PROMPT,
  assets: [
    {
      id: "asset-red-sun",
      url: "/captures/red-sun.webp",
      alt: "RedSun dark landing page capture",
      width: 1200,
      height: 1600,
      mimeType: "image/webp",
    },
  ],
  createdAt: "2026-07-01T12:00:00.000Z",
  updatedAt: "2026-07-01T12:00:00.000Z",
};

const blockedDither: Inspiration = {
  ...redSun,
  id: "inspiration-dither",
  title: "Dither Mono Index",
  sourceUrl: "https://example.test/dither",
  source: "Direct site",
  aestheticFamily: "Dither Mono",
  vocabulary: ["dither", "monochrome", "index", "bitmap", "dense", "technical"],
  tags: ["motion"],
  categoryIds: ["dither-mono"],
  captureType: "metadata",
  status: "blocked",
  confidence: "low",
  limitation: "Remote page blocked capture; metadata only.",
  brief: "Use monochrome dither as evidence texture.",
  prompt: undefined,
  assets: [],
};

const categories: readonly Category[] = [
  {
    id: "vast-quiet",
    name: "Vast Quiet / Cinematic",
    provisional: true,
    retired: false,
  },
  { id: "dither-mono", name: "Dither Mono", provisional: true, retired: false },
];

const snapshot: LibrarySnapshot = {
  inspirations: [redSun, blockedDither],
  categories,
  briefs: [],
  captureTypes: ["screenshot", "metadata"],
  sources: ["Pinterest", "Direct site"],
  tags: ["dark-saas", "cinematic-glow", "motion"],
  systemStatus: "ready",
  statusMessage: "Library ready · imported evidence available.",
};

const canonicalBrief = `# RedSun direction

## Aesthetic family
Dark cinematic SaaS

## Visual vocabulary
- editorial
- ember-orange CTA glow
- paper grain
- ruled
- asymmetric
- display type

## References and borrowed qualities
- RedSun scale contrast and optical registration

## Intent
Create a calm but unmistakable visual research direction.

## Audience
The designer operating the local workbench.

## Primary action
Select a direction and use its prompt.

## Always
- Preserve evidence labels and typographic hierarchy

## Never
- Add generic dashboard chrome

## Open risks
- The source is represented by one captured frame

## Final copy-ready generation prompt
Editorial poster, red sun, black ink rules, vast quiet, paper grain.
`;

class FakeLibraryRepository implements LibraryRepository {
  readonly created: InspirationDraft[] = [];
  readonly renamed: Array<{ id: string; name: string }> = [];
  readonly retired: string[] = [];
  readonly imported: BriefImport[] = [];

  constructor(readonly value: LibrarySnapshot = snapshot) {}

  async load(): Promise<LibrarySnapshot> {
    return this.value;
  }

  async createInspiration(input: InspirationDraft): Promise<Inspiration> {
    this.created.push(input);
    return { ...redSun, ...input, id: "created-reference", assets: [] };
  }

  async updateInspiration(
    _id: string,
    input: InspirationDraft,
  ): Promise<Inspiration> {
    return { ...redSun, ...input };
  }

  async renameCategory(id: string, name: string): Promise<Category> {
    this.renamed.push({ id, name });
    return { id, name, provisional: true, retired: false };
  }

  async retireCategory(id: string): Promise<Category> {
    this.retired.push(id);
    return { id, name: "Dither Mono", provisional: true, retired: true };
  }

  async importBrief(input: BriefImport): Promise<DesignBrief> {
    this.imported.push(input);
    return {
      id: "brief-red-sun",
      title: "RedSun direction",
      markdown: input.markdown,
      finalPrompt: REDSUN_PROMPT,
      createdAt: "2026-07-01T12:00:00.000Z",
      sourceInspirationId: input.sourceInspirationId,
    };
  }

  async createBriefFromInspiration(id: string): Promise<DesignBrief> {
    return {
      id: "brief-from-inspiration",
      title: "RedSun direction",
      markdown: canonicalBrief,
      finalPrompt: REDSUN_PROMPT,
      createdAt: "2026-07-01T12:00:00.000Z",
      sourceInspirationId: id,
    };
  }
}

let browserWindow: Window;
let clipboardWrites: string[];
let App: (typeof import("../../src/client/App"))["App"];
let cleanup: (typeof import("@testing-library/react/pure"))["cleanup"];
let fireEvent: (typeof import("@testing-library/react/pure"))["fireEvent"];
let render: (typeof import("@testing-library/react/pure"))["render"];
let view: RenderResult;
let waitFor: (typeof import("@testing-library/react/pure"))["waitFor"];
let within: (typeof import("@testing-library/react/pure"))["within"];

beforeAll(async () => {
  browserWindow = new Window({ url: "http://localhost/library" });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: browserWindow },
    document: { configurable: true, value: browserWindow.document },
    navigator: { configurable: true, value: browserWindow.navigator },
    HTMLElement: { configurable: true, value: browserWindow.HTMLElement },
    HTMLDialogElement: {
      configurable: true,
      value: browserWindow.HTMLDialogElement,
    },
    File: { configurable: true, value: browserWindow.File },
    FormData: { configurable: true, value: browserWindow.FormData },
  });

  ({ App } = await import("../../src/client/App"));
  ({ cleanup, fireEvent, render, waitFor, within } =
    await import("@testing-library/react/pure"));

  const dialogPrototype = browserWindow.HTMLDialogElement.prototype;
  dialogPrototype.showModal = function showModal() {
    this.open = true;
  };
  dialogPrototype.close = function close() {
    this.open = false;
    this.dispatchEvent(new browserWindow.Event("close"));
  };
});

beforeEach(() => {
  cleanup();
  browserWindow.history.replaceState(null, "", "/library");
  clipboardWrites = [];
  Object.defineProperty(browserWindow.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText(value: string) {
        clipboardWrites.push(value);
        return Promise.resolve();
      },
    },
  });
});

afterAll(() => {
  cleanup();
  browserWindow.close();
});

async function renderLibrary(
  repository: LibraryRepository = new FakeLibraryRepository(),
) {
  view = render(<App repository={repository} />);
  await view.findByText(snapshot.statusMessage);
}

function setInput(label: string, value: string) {
  fireEvent.change(view.getByLabelText(label), { target: { value } });
}

describe("Library observable behavior", () => {
  test("loads imported evidence and reports the system status", async () => {
    await renderLibrary();

    expect(
      view.getByRole("heading", { level: 1, name: "Library" }),
    ).toBeTruthy();
    expect(view.getByText(snapshot.statusMessage)).toBeTruthy();
    expect(view.getByText("2 of 2 references in view")).toBeTruthy();
  });

  test("filters the contact sheet by text, status, and category", async () => {
    await renderLibrary();

    setInput("Search", "redsun");
    expect(
      view.getByRole("button", { name: `Open ${REDSUN_TITLE}` }),
    ).toBeTruthy();
    expect(
      view.queryByRole("button", { name: "Open Dither Mono Index" }),
    ).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Clear filters" }));
    setInput("Status", "blocked");
    setInput("Category", "dither-mono");
    expect(
      view.getByRole("button", { name: "Open Dither Mono Index" }),
    ).toBeTruthy();
    expect(
      view.queryByRole("button", { name: `Open ${REDSUN_TITLE}` }),
    ).toBeNull();
  });

  test("renders evidence status labels and intrinsic lazy image dimensions", async () => {
    await renderLibrary();

    expect(
      view
        .getAllByText("captured")
        .find((element) => element.getAttribute("data-status") === "captured"),
    ).toBeTruthy();
    expect(
      view
        .getAllByText("blocked")
        .find((element) => element.getAttribute("data-status") === "blocked"),
    ).toBeTruthy();
    const image = view.getByRole("img", {
      name: "RedSun dark landing page capture",
    });
    expect(image.getAttribute("width")).toBe("1200");
    expect(image.getAttribute("height")).toBe("1600");
    expect(image.getAttribute("loading")).toBe("lazy");
  });

  test("opens an accessible detail dialog, exposes analysis, copies exact payloads, and closes", async () => {
    await renderLibrary();
    const opener = view.getByRole("button", { name: `Open ${REDSUN_TITLE}` });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await view.findByRole("dialog", { name: REDSUN_TITLE });
    expect(
      within(dialog).getByText(
        "Showcase a dark AI landing page through scroll behavior and lighting treatment.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText("ember-orange CTA glow")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "The evidence does not establish implementation details or every intermediate transition.",
      ),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Copy brief" }));
    await waitFor(() => expect(clipboardWrites).toEqual([REDSUN_BRIEF]));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy prompt" }),
    );
    await waitFor(() =>
      expect(clipboardWrites).toEqual([REDSUN_BRIEF, REDSUN_PROMPT]),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(browserWindow.document.activeElement === (opener as unknown)).toBe(
      true,
    );
  });

  test("surfaces inspiration-to-brief contract failures inside the modal", async () => {
    class PrefillFailureRepository extends FakeLibraryRepository {
      override createBriefFromInspiration(): Promise<DesignBrief> {
        return Promise.reject(
          new Error(
            "BRIEF_PREFILL_CONTRACT_UNAVAILABLE: Canonical prefill content is unavailable.",
          ),
        );
      }
    }

    await renderLibrary(new PrefillFailureRepository());
    fireEvent.click(view.getByRole("button", { name: `Open ${REDSUN_TITLE}` }));
    const dialog = await view.findByRole("dialog", { name: REDSUN_TITLE });
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Create brief from inspiration",
      }),
    );

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "BRIEF_PREFILL_CONTRACT_UNAVAILABLE: Canonical prefill content is unavailable.",
    );
  });

  test("rejects invalid vocabulary without mutating the repository", async () => {
    const repository = new FakeLibraryRepository();
    await renderLibrary(repository);
    fireEvent.click(view.getByRole("button", { name: "Add reference" }));

    setInput("Source URL", "https://example.test/manual");
    setInput("Title", REDSUN_TITLE);
    setInput("Aesthetic family", "Dark cinematic SaaS");
    setInput(
      "Visual vocabulary (5–8, comma separated)",
      "near-black canvas, ember-orange CTA glow, orbital arc, hero type",
    );
    setInput("Limitation", "Manual URL entry without a screenshot.");
    setInput("Brief", "Keep the proofing marks legible.");
    fireEvent.click(view.getByRole("button", { name: "Save reference" }));

    expect((await view.findByRole("alert")).textContent).toBe(
      "VOCABULARY_INVALID: Enter 5–8 comma-separated terms.",
    );
    expect(repository.created.length).toBe(0);
  });

  test("restores focus after canceling add and edit flows", async () => {
    await renderLibrary();
    const addButton = view.getByRole("button", { name: "Add reference" });
    addButton.focus();
    fireEvent.click(addButton);

    await view.findByRole("heading", { name: "Add reference" });
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        browserWindow.document.activeElement === (addButton as unknown),
      ).toBe(true),
    );

    const contactOpener = view.getByRole("button", {
      name: `Open ${REDSUN_TITLE}`,
    });
    contactOpener.focus();
    fireEvent.click(contactOpener);
    const dialog = await view.findByRole("dialog", { name: REDSUN_TITLE });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Edit reference" }),
    );

    await view.findByRole("heading", { name: "Edit reference" });
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      const remountedOpener = view.getByRole("button", {
        name: `Open ${REDSUN_TITLE}`,
      });
      expect(
        browserWindow.document.activeElement === (remountedOpener as unknown),
      ).toBe(true);
    });
  });

  test("submits the labeled create form and category management caller payloads", async () => {
    const repository = new FakeLibraryRepository();
    await renderLibrary(repository);
    fireEvent.click(view.getByRole("button", { name: "Add reference" }));

    setInput("Source URL", "https://example.test/manual");
    setInput("Title", REDSUN_TITLE);
    setInput("Aesthetic family", "Dark cinematic SaaS");
    setInput(
      "Visual vocabulary (5–8, comma separated)",
      "near-black canvas, ember-orange CTA glow, luminous orbital arc, centered oversized hero type, frosted dark panels",
    );
    setInput("Tags (comma separated)", "dark-saas, cinematic-glow");
    fireEvent.click(
      view.getByLabelText("Vast Quiet / Cinematic — provisional"),
    );
    const editor = view
      .getByRole("heading", { name: "Add reference" })
      .closest("form");
    if (!editor) throw new Error("Add reference form was not rendered");
    fireEvent.change(within(editor).getByLabelText("Status"), {
      target: { value: "partial" },
    });
    setInput("Limitation", "Manual URL entry without a screenshot.");
    setInput("Brief", "Keep the proofing marks legible.");
    fireEvent.click(view.getByRole("button", { name: "Save reference" }));

    await waitFor(() => expect(repository.created.length).toBe(1));
    expect(repository.created[0]).toEqual({
      sourceUrl: "https://example.test/manual",
      screenshot: undefined,
      title: REDSUN_TITLE,
      aestheticFamily: "Dark cinematic SaaS",
      vocabulary: [
        "near-black canvas",
        "ember-orange CTA glow",
        "luminous orbital arc",
        "centered oversized hero type",
        "frosted dark panels",
      ],
      tags: ["dark-saas", "cinematic-glow"],
      categoryIds: ["vast-quiet"],
      status: "partial",
      limitation: "Manual URL entry without a screenshot.",
      brief: "Keep the proofing marks legible.",
    });

    const categoryList = view.getByRole("heading", {
      name: "Category register",
    }).parentElement;
    if (!categoryList)
      throw new Error("Category register section was not rendered.");
    const ditherName = within(categoryList).getByDisplayValue("Dither Mono");
    const ditherForm = ditherName.closest("form");
    if (!ditherForm)
      throw new Error("Dither category controls were not rendered in a form.");
    fireEvent.change(ditherName, { target: { value: "Dither Archive" } });
    fireEvent.click(within(ditherForm).getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(repository.renamed).toContainEqual({
        id: "dither-mono",
        name: "Dither Archive",
      }),
    );
    fireEvent.click(within(ditherForm).getByRole("button", { name: "Retire" }));
    await waitFor(() => expect(repository.retired).toEqual(["dither-mono"]));
  });

  test("validates canonical brief imports before calling the repository", async () => {
    const repository = new FakeLibraryRepository();
    browserWindow.history.replaceState(null, "", "/briefs");
    view = render(<App repository={repository} />);
    await view.findByText(snapshot.statusMessage);

    setInput("Brief Markdown", "# Incomplete");
    fireEvent.click(view.getByRole("button", { name: "Import brief" }));
    expect((await view.findByRole("alert")).textContent).toBe(
      "Design brief validation failed",
    );
    expect(repository.imported.length).toBe(0);

    setInput("Brief Markdown", canonicalBrief);
    fireEvent.click(view.getByRole("button", { name: "Import brief" }));
    await waitFor(() =>
      expect(repository.imported).toEqual([{ markdown: canonicalBrief }]),
    );
  });

  test("surfaces the stable unavailable-contract error", async () => {
    view = render(<App />);

    expect(
      await view.findByRole("heading", {
        name: "Library contract unavailable",
      }),
    ).toBeTruthy();
    expect(view.getByRole("alert").textContent).toBe(API_CONTRACT_UNAVAILABLE);
  });
});
