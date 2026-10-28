import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  createHttpComparisonRepository,
  type FetchLike,
} from "../../src/client/components/compare/repository";
import { comparisonSchema } from "../../src/client/components/compare/types";
import { createApiFetchHandler } from "../../src/server/api";
import { migrateDatabase } from "../../src/server/database";

const VALID_BRIEF = `# API Contract Proof

## Aesthetic family
Editorial proofing

## Visual vocabulary
- measured
- typographic
- quiet
- structured
- tactile

## References and borrowed qualities
- Print proof registers

## Intent
Prove the comparison API contract.

## Audience
Design operators.

## Primary action
Compare variants.

## Always
- Keep viewports equal

## Never
- Hide errors

## Open risks
- Missing artifacts

## Final copy-ready generation prompt
Build an observable comparison fixture.
`;

const TRUSTED_APP_ORIGIN = "http://127.0.0.1:4173";

const comparison = comparisonSchema.parse({
  id: "comparison-1",
  slug: "comparison-one",
  title: "Comparison One",
  sourceBriefId: "brief-1",
  status: "draft",
  createdAt: "2026-07-24T12:00:00.000Z",
  updatedAt: "2026-07-24T12:00:00.000Z",
  directions: [
    {
      id: "direction-1",
      position: 0,
      slug: "direction-1",
      title: "Direction 1",
      metadata: {},
      createdAt: "2026-07-24T12:00:00.000Z",
      variants: [],
    },
  ],
});

describe("comparison HTTP repository", () => {
  test("uses the list, detail, and create API contracts", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return Response.json(
        init?.method === "POST" || url.endsWith("/comparison-1")
          ? comparison
          : [comparison],
      );
    };
    const repository = createHttpComparisonRepository({
      apiOrigin: "http://127.0.0.1:4173",
      fetchImpl,
    });

    expect(await repository.list()).toEqual([comparison]);
    expect((await repository.get("comparison-1")).id).toBe("comparison-1");
    expect(
      (await repository.create({ brief: "brief-1", directions: 3 })).id,
    ).toBe("comparison-1");
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:4173/api/comparisons",
        method: "GET",
        body: undefined,
      },
      {
        url: "http://127.0.0.1:4173/api/comparisons/comparison-1",
        method: "GET",
        body: undefined,
      },
      {
        url: "http://127.0.0.1:4173/api/comparisons",
        method: "POST",
        body: '{"brief":"brief-1","directions":3}',
      },
    ]);
  });

  test("fails loudly when the trusted API returns malformed data", async () => {
    const repository = createHttpComparisonRepository({
      apiOrigin: "http://127.0.0.1:4173",
      fetchImpl: async () => Response.json([{ id: "thin" }]),
    });
    await expect(repository.list()).rejects.toThrow(
      "does not match the client contract",
    );
  });

  test("preserves stable server errors and rejects invalid create input before fetch", async () => {
    let calls = 0;
    const repository = createHttpComparisonRepository({
      apiOrigin: "http://127.0.0.1:4173",
      fetchImpl: async () => {
        calls += 1;
        return Response.json(
          {
            error: {
              code: "BRIEF_NOT_FOUND",
              message: "Saved brief is missing.",
            },
          },
          { status: 404 },
        );
      },
    });
    await expect(
      repository.create({ brief: "brief-1", directions: 6 }),
    ).rejects.toThrow("Choose a source and one to five directions");
    expect(calls).toBe(0);
    await expect(repository.get("missing")).rejects.toThrow(
      "Saved brief is missing.",
    );
    expect(calls).toBe(1);
  });

  test("matches the live trusted API list, create, and detail response shapes", async () => {
    const runRoot = resolve(
      (process.env.TMPDIR ?? "/tmp") +
        "/design-workbench/compare-client-api-tests",
      crypto.randomUUID(),
    );
    const archiveRoot = resolve(
      (process.env.TMPDIR ?? "/tmp") +
        "/design-workbench/compare-client-api-tests/_archive",
    );
    const generatedRoot = resolve(runRoot, "generated-variants");
    const assetRoot = resolve(runRoot, "assets");
    mkdirSync(generatedRoot, { recursive: true });
    mkdirSync(assetRoot, { recursive: true });
    const database = new Database(":memory:", { strict: true });
    migrateDatabase(database);
    const now = "2026-07-24T12:00:00.000Z";
    database
      .query(
        `INSERT INTO briefs (
          id, slug, title, markdown, final_prompt, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "brief-api",
        "brief-api",
        "API Contract Proof",
        VALID_BRIEF,
        "Build an observable comparison fixture.",
        now,
        now,
      );
    const handler = createApiFetchHandler({
      database,
      assetRoot,
      generatedVariantsRoot: generatedRoot,
      allowedOrigins: [TRUSTED_APP_ORIGIN],
    });
    const fetchImpl: FetchLike = async (input, init) => {
      const headers = new Headers(init?.headers);
      const method = (init?.method ?? "GET").toUpperCase();
      if (
        init?.body !== undefined ||
        !["GET", "HEAD", "OPTIONS"].includes(method)
      ) {
        headers.set("Origin", TRUSTED_APP_ORIGIN);
      }
      return handler(new Request(input, { ...init, headers }));
    };
    const repository = createHttpComparisonRepository({
      apiOrigin: TRUSTED_APP_ORIGIN,
      fetchImpl,
    });

    try {
      expect(await repository.list()).toEqual([]);
      const created = await repository.create({
        brief: "brief-api",
        directions: 2,
      });
      expect(created.directions).toHaveLength(2);
      expect((await repository.list()).map((item) => item.id)).toEqual([
        created.id,
      ]);
      expect((await repository.get(created.id)).id).toBe(created.id);
    } finally {
      database.close();
      mkdirSync(archiveRoot, { recursive: true });
      Bun.spawnSync(["mv", runRoot, resolve(archiveRoot, crypto.randomUUID())]);
    }
  });
});
