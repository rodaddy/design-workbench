import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { HttpLibraryRepository } from "../../src/client/library/http-repository";

const NOW = "2026-07-24T12:00:00.000Z";

const category = {
  id: "category-vast-quiet",
  slug: "vast-quiet-cinematic",
  name: "Vast Quiet / Cinematic",
  description: "Expansive, sparse compositions.",
  inclusionRules: "One environmental form establishes scale.",
  exclusionRules: "No dense dashboard inventories.",
  isProvisional: true,
  isRetired: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const inspiration = {
  id: "inspiration-redsun",
  sourceUrl: "https://www.pinterest.com/pin/844493676784201/",
  resolvedUrl: null,
  title: "RedSun AI Landing Page — Scroll-Lit Product Showcase",
  purpose:
    "A vertical showcase of a dark AI landing page led by lighting and scroll behavior.",
  aestheticFamily: "Dark cinematic SaaS",
  visualVocabulary: [
    "Near-black canvas",
    "Ember-orange CTA glow",
    "Luminous orbital arc",
    "Centered oversized hero type",
    "Frosted dark panels",
  ],
  brief:
    "Design a dark, cinematic landing page for a sophisticated software product.",
  captureType: "motion",
  confidence: "high",
  sourceStatus: "captured",
  provenancePath: "taste-board/inbox/batch-001/pinterest/pin-1.md",
  limitation:
    "The evidence does not establish implementation details or every intermediate transition.",
  createdAt: NOW,
  updatedAt: NOW,
  tags: ["dark-saas", "cinematic-glow"],
  categories: [category],
  assets: [
    {
      id: "asset-redsun-frame",
      relativePath:
        "captures/taste-board/batch-001/pinterest/pin-1/frame-02s.jpg",
      mimeType: "image/jpeg",
      role: "evidence",
      contentHash: null,
      isAvailable: true,
      motionTimestampMs: 2_000,
    },
  ],
};

const brief = {
  id: "brief-redsun",
  slug: "redsun-direction",
  title: "RedSun direction",
  markdown: "# RedSun direction\n",
  finalPrompt: "Use a dark cinematic composition.",
  sourceInspirationId: inspiration.id,
  createdAt: NOW,
  updatedAt: NOW,
};

const originalFetch = globalThis.fetch;
let calls: Array<{
  body: BodyInit | null | undefined;
  method: string;
  url: string;
}>;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function installFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({
      body: init.body,
      method: init.method ?? "GET",
      url,
    });
    return handler(url, init);
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("HttpLibraryRepository", () => {
  test("normalizes the live API and degrades loudly when asset dimensions are absent", async () => {
    installFetch((url) => {
      if (url === "/api/health") return json({ ok: true });
      if (url === "/api/inspirations") return json([inspiration]);
      if (url === "/api/categories?includeRetired=true")
        return json([category]);
      if (url === "/api/briefs") return json([brief]);
      return json({ error: { code: "not_found", message: "Not found" } }, 404);
    });

    const snapshot = await new HttpLibraryRepository().load();

    expect(snapshot.systemStatus).toBe("degraded");
    expect(snapshot.statusMessage).toContain(
      "1 local evidence asset is withheld pending validated URL and dimensions",
    );
    expect(snapshot.inspirations[0]).toMatchObject({
      title: inspiration.title,
      source: "www.pinterest.com",
      status: "captured",
      confidence: "high",
      categoryIds: [category.id],
      assets: [],
    });
    expect(snapshot.inspirations[0]?.prompt).toBeUndefined();
    expect(snapshot.captureTypes).toEqual(["motion"]);
    expect(snapshot.tags).toEqual(["cinematic-glow", "dark-saas"]);
  });

  test("maps a labeled manual entry and uploads its optional screenshot", async () => {
    installFetch((url, init) => {
      if (url === "/api/inspirations" && init.method === "POST") {
        return json(inspiration, 201);
      }
      if (
        url === `/api/inspirations/${inspiration.id}/assets` &&
        init.method === "POST"
      ) {
        return json(inspiration, 201);
      }
      return json({ error: { code: "not_found", message: "Not found" } }, 404);
    });
    const screenshot = new File([new Uint8Array([1, 2, 3])], "reference.png", {
      type: "image/png",
    });

    await new HttpLibraryRepository().createInspiration({
      sourceUrl: inspiration.sourceUrl,
      screenshot,
      title: inspiration.title,
      aestheticFamily: inspiration.aestheticFamily,
      vocabulary: inspiration.visualVocabulary,
      tags: inspiration.tags,
      categoryIds: [category.id],
      status: "partial",
      limitation: inspiration.limitation,
      brief: inspiration.brief,
    });

    expect(calls.length).toBe(2);
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({
      captureType: "image",
      confidence: "medium",
      sourceStatus: "partial",
      visualVocabulary: inspiration.visualVocabulary,
    });
    const upload = calls[1]?.body;
    expect(upload).toBeInstanceOf(FormData);
    const uploadedFile = (upload as FormData).get("file");
    expect(uploadedFile).toBeInstanceOf(File);
    expect((uploadedFile as File).name).toBe(screenshot.name);
    expect((uploadedFile as File).type).toBe(screenshot.type);
    expect((uploadedFile as File).size).toBe(screenshot.size);
  });

  test("preserves capture metadata when editing an imported reference", async () => {
    installFetch((url, init) => {
      if (
        url === `/api/inspirations/${inspiration.id}` &&
        init.method === "PATCH"
      ) {
        return json(inspiration);
      }
      return json({ error: { code: "not_found", message: "Not found" } }, 404);
    });

    await new HttpLibraryRepository().updateInspiration(inspiration.id, {
      sourceUrl: inspiration.sourceUrl,
      title: inspiration.title,
      aestheticFamily: inspiration.aestheticFamily,
      vocabulary: inspiration.visualVocabulary,
      tags: inspiration.tags,
      categoryIds: [category.id],
      status: "partial",
      limitation: inspiration.limitation,
      brief: inspiration.brief,
    });

    const payload = JSON.parse(String(calls[0]?.body)) as Record<
      string,
      unknown
    >;
    expect(payload.sourceStatus).toBe("partial");
    expect(payload.captureType).toBeUndefined();
    expect(payload.confidence).toBeUndefined();
  });

  test("reports partial persistence when screenshot upload fails", async () => {
    installFetch((url, init) => {
      if (url === "/api/inspirations" && init.method === "POST") {
        return json(inspiration, 201);
      }
      return json(
        {
          error: {
            code: "asset_write_failed",
            message: "Asset could not be stored",
          },
        },
        500,
      );
    });
    const screenshot = new File([new Uint8Array([1])], "reference.png", {
      type: "image/png",
    });

    await expect(
      new HttpLibraryRepository().createInspiration({
        sourceUrl: inspiration.sourceUrl,
        screenshot,
        title: inspiration.title,
        aestheticFamily: inspiration.aestheticFamily,
        vocabulary: inspiration.visualVocabulary,
        tags: inspiration.tags,
        categoryIds: [category.id],
        status: "partial",
        limitation: inspiration.limitation,
        brief: inspiration.brief,
      }),
    ).rejects.toMatchObject({
      code: "INSPIRATION_ASSET_UPLOAD_PARTIAL",
      message:
        "INSPIRATION_ASSET_UPLOAD_PARTIAL: The reference was created, but its screenshot upload failed. Reload and edit the saved reference to retry.",
    });
  });

  test("surfaces stable API errors without leaking an unvalidated body", async () => {
    installFetch(() =>
      json(
        {
          error: {
            code: "conflict",
            message: "Store request failed: conflict",
          },
        },
        409,
      ),
    );

    await expect(
      new HttpLibraryRepository().renameCategory(category.id, category.name),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "conflict: Store request failed: conflict",
    });
  });
});
