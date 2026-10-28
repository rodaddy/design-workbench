import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createApiFetchHandler } from "../../src/server/api";
import { migrateDatabase } from "../../src/server/database";

const TEMP_ROOT = (process.env.TMPDIR ?? "/tmp") + "/design-workbench";
const ARCHIVE_ROOT = join(TEMP_ROOT, "_archive");
const ORIGIN = "http://127.0.0.1:5173";
let runRoot = "";
let database: Database;
let fetchApi: (request: Request) => Promise<Response>;

beforeEach(async () => {
  await mkdir(ARCHIVE_ROOT, { recursive: true });
  runRoot = await mkdtemp(join(TEMP_ROOT, "api-test-"));
  const assets = join(runRoot, "assets");
  const generated = join(runRoot, "generated");
  await mkdir(assets);
  await mkdir(generated);
  database = new Database(":memory:", { strict: true });
  migrateDatabase(database);
  fetchApi = createApiFetchHandler({
    database,
    assetRoot: assets,
    generatedVariantsRoot: generated,
    allowedOrigins: [ORIGIN],
  });
});

afterEach(async () => {
  database.close();
  await rename(
    runRoot,
    join(ARCHIVE_ROOT, `${Date.now()}-${crypto.randomUUID()}`),
  );
});

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    ...init,
    headers: { Origin: ORIGIN, ...init?.headers },
  });
}

const inspiration = {
  id: "one",
  sourceUrl: "https://example.com/one",
  title: "Quiet",
  captureType: "screenshot",
  confidence: "high",
  sourceStatus: "captured",
};
const briefMarkdown = `# Quiet interface

## Aesthetic family
Editorial minimalism

## Visual vocabulary
- restrained
- tactile
- spacious
- typographic
- warm

## References and borrowed qualities
- Print hierarchy

## Intent
Make comparison calm.

## Audience
Designers

## Primary action
Compare variants

## Always
- Preserve hierarchy

## Never
- Add visual noise

## Open risks
- Low contrast

## Final copy-ready generation prompt
Build a calm comparison interface.
`;

describe("trusted API", () => {
  test("creates one reusable canonical brief from an inspiration", async () => {
    const createdInspiration = await fetchApi(
      request("/api/inspirations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...inspiration,
          purpose: "Explore a restrained visual direction.",
          aestheticFamily: "Quiet technical minimalism",
          visualVocabulary: [
            "restrained",
            "measured",
            "technical",
            "quiet",
            "precise",
          ],
          brief: "Borrow compact hierarchy and calm pacing.",
          limitation: "One captured viewport is available.",
        }),
      }),
    );
    expect(createdInspiration.status).toBe(201);

    const first = await fetchApi(
      request("/api/inspirations/one/brief", { method: "POST" }),
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.sourceInspirationId).toBe("one");
    expect(firstBody.markdown).toContain("## Visual vocabulary");
    expect(firstBody.markdown).toContain("Borrow compact hierarchy");

    const repeated = await fetchApi(
      request("/api/inspirations/one/brief", { method: "POST" }),
    );
    expect(repeated.status).toBe(201);
    expect((await repeated.json()).id).toBe(firstBody.id);
    expect(
      database.query("SELECT COUNT(*) AS count FROM briefs").get(),
    ).toEqual({
      count: 1,
    });
  });

  test("rejects untrusted and missing origins on unsafe methods", async () => {
    const forbidden = await fetchApi(
      request("/api/inspirations", {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(inspiration),
      }),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: {
        code: "origin_forbidden",
        message: "Request origin is not trusted",
      },
    });

    const missing = await fetchApi(
      new Request("http://127.0.0.1:3000/api/inspirations", {
        method: "POST",
        body: JSON.stringify(inspiration),
      }),
    );
    expect(missing.status).toBe(403);
  });

  test("returns stable invalid JSON and body limit errors", async () => {
    const invalid = await fetchApi(
      request("/api/inspirations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: {
        code: "invalid_json",
        message: "Request body must be valid UTF-8 JSON",
      },
    });
    const oversized = await fetchApi(
      request("/api/inspirations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(1024 * 1024 + 1),
        },
        body: "{}",
      }),
    );
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error.code).toBe("body_too_large");
  });

  test("rejects empty library PATCH requests without timestamp mutation", async () => {
    await fetchApi(
      request("/api/inspirations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inspiration),
      }),
    );
    await fetchApi(
      request("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "paper", slug: "paper", name: "Paper" }),
      }),
    );
    await fetchApi(
      request("/api/briefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "brief-empty-patch",
          slug: "empty-patch",
          markdown: briefMarkdown,
        }),
      }),
    );
    const unchangedAt = "2000-01-01T00:00:00.000Z";
    database
      .query("UPDATE inspirations SET updated_at = ? WHERE id = ?")
      .run(unchangedAt, "one");
    database
      .query("UPDATE categories SET updated_at = ? WHERE id = ?")
      .run(unchangedAt, "paper");
    database
      .query("UPDATE briefs SET updated_at = ? WHERE id = ?")
      .run(unchangedAt, "brief-empty-patch");

    for (const path of [
      "/api/inspirations/one",
      "/api/categories/paper",
      "/api/briefs/brief-empty-patch",
    ]) {
      const response = await fetchApi(
        request(path, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid");
    }

    expect(
      (await (await fetchApi(request("/api/inspirations/one"))).json())
        .updatedAt,
    ).toBe(unchangedAt);
    expect(
      (await (await fetchApi(request("/api/categories"))).json())[0].updatedAt,
    ).toBe(unchangedAt);
    expect(
      (await (await fetchApi(request("/api/briefs/brief-empty-patch"))).json())
        .updatedAt,
    ).toBe(unchangedAt);
  });

  test("creates, filters, retrieves, and updates library resources", async () => {
    const created = await fetchApi(
      request("/api/inspirations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inspiration),
      }),
    );
    expect(created.status).toBe(201);
    const list = await fetchApi(request("/api/inspirations?q=Quiet"));
    expect(await list.json()).toHaveLength(1);
    const patched = await fetchApi(
      request("/api/inspirations/one", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Quieter" }),
      }),
    );
    expect((await patched.json()).title).toBe("Quieter");

    const category = await fetchApi(
      request("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "paper", slug: "paper", name: "Paper" }),
      }),
    );
    expect(category.status).toBe(201);
    expect(
      (await (await fetchApi(request("/api/categories"))).json())[0].slug,
    ).toBe("paper");
  });

  test("stores and registers a valid bounded upload", async () => {
    await fetchApi(
      request("/api/inspirations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inspiration),
      }),
    );
    const form = new FormData();
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
    ]);
    form.append("file", new Blob([png], { type: "image/png" }), "proof.png");
    const response = await fetchApi(
      request("/api/inspirations/one/assets", {
        method: "POST",
        headers: { "X-Asset-Role": "primary" },
        body: form,
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.assets[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.assets[0].role).toBe("primary");

    const oversized = await fetchApi(
      request("/api/inspirations/one/assets", {
        method: "POST",
        headers: {
          "Content-Type": "multipart/form-data; boundary=proof",
          "Content-Length": String(10 * 1024 * 1024 + 1),
        },
        body: "x",
      }),
    );
    expect(oversized.status).toBe(413);
  });

  test("creates and updates comparisons and registers a contained variant", async () => {
    const savedBrief = await fetchApi(
      request("/api/briefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "brief-one",
          slug: "quiet",
          markdown: briefMarkdown,
        }),
      }),
    );
    expect(savedBrief.status).toBe(201);
    const created = await fetchApi(
      request("/api/comparisons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: "brief-one", directions: 1 }),
      }),
    );
    expect(created.status).toBe(201);
    const comparison = await created.json();
    const artifactPath = join(
      runRoot,
      "generated",
      comparison.id,
      comparison.directions[0].slug,
      "impeccable",
    );
    await writeFile(join(artifactPath, "index.html"), "<main>Variant</main>");
    const registered = await fetchApi(
      request("/api/variants/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          comparison: comparison.id,
          direction: comparison.directions[0].id,
          engine: "impeccable",
          path: artifactPath,
        }),
      }),
    );
    expect(registered.status).toBe(201);
    const patched = await fetchApi(
      request(`/api/comparisons/${comparison.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ready" }),
      }),
    );
    expect((await patched.json()).status).toBe("ready");
  });

  test("reports corrupt stored comparison data as a stable server error", async () => {
    const savedBrief = await fetchApi(
      request("/api/briefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "brief-corrupt",
          slug: "corrupt",
          markdown: briefMarkdown,
        }),
      }),
    );
    expect(savedBrief.status).toBe(201);
    const created = await fetchApi(
      request("/api/comparisons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: "brief-corrupt", directions: 1 }),
      }),
    );
    const comparison = await created.json();
    database.run("PRAGMA ignore_check_constraints = ON");
    database
      .query("UPDATE aesthetic_directions SET metadata = ? WHERE id = ?")
      .run("{", comparison.directions[0].id);
    database.run("PRAGMA ignore_check_constraints = OFF");

    const response = await fetchApi(
      request(`/api/comparisons/${comparison.id}`),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "comparison_data_invalid",
        message: "Stored direction metadata is invalid",
      },
    });
  });

  test("reports corrupt stored inspiration data as a stable server error", async () => {
    await fetchApi(
      request("/api/inspirations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inspiration),
      }),
    );
    database.run("PRAGMA ignore_check_constraints = ON");
    database
      .query("UPDATE inspirations SET visual_vocabulary = ? WHERE id = ?")
      .run("{", "one");
    database.run("PRAGMA ignore_check_constraints = OFF");

    const response = await fetchApi(request("/api/inspirations/one"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "data_invalid",
        message: "Store request failed: data_invalid",
        issues: "invalid_visual_vocabulary",
      },
    });
  });

  test("returns stable server errors for operational backend failures", async () => {
    const invalidRoot = join(runRoot, "not-a-directory");
    await writeFile(invalidRoot, "occupied");
    const invalidAssetHandler = createApiFetchHandler({
      database,
      assetRoot: invalidRoot,
      generatedVariantsRoot: join(runRoot, "generated"),
      allowedOrigins: [ORIGIN],
    });
    await fetchApi(
      request("/api/inspirations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inspiration),
      }),
    );
    const form = new FormData();
    form.append(
      "file",
      new Blob(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])],
        { type: "image/png" },
      ),
      "proof.png",
    );
    const upload = await invalidAssetHandler(
      request("/api/inspirations/one/assets", {
        method: "POST",
        body: form,
      }),
    );
    expect(upload.status).toBe(500);
    expect((await upload.json()).error.code).toBe("storage_io_error");

    await fetchApi(
      request("/api/briefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "brief-operational",
          slug: "operational",
          markdown: briefMarkdown,
        }),
      }),
    );
    const invalidGeneratedHandler = createApiFetchHandler({
      database,
      assetRoot: join(runRoot, "assets"),
      generatedVariantsRoot: invalidRoot,
      allowedOrigins: [ORIGIN],
    });
    const comparison = await invalidGeneratedHandler(
      request("/api/comparisons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: "brief-operational", directions: 1 }),
      }),
    );
    expect(comparison.status).toBe(500);
    expect((await comparison.json()).error.code).toBe(
      "comparison_create_failed",
    );

    const created = await fetchApi(
      request("/api/comparisons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: "brief-operational", directions: 1 }),
      }),
    );
    const savedComparison = await created.json();
    const variant = await invalidGeneratedHandler(
      request("/api/variants/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          comparison: savedComparison.id,
          direction: savedComparison.directions[0].id,
          engine: "taste",
          path: join(runRoot, "generated"),
        }),
      }),
    );
    expect(variant.status).toBe(500);
    expect((await variant.json()).error.code).toBe("invalid_generated_root");
  });

  test("rejects ambiguous variant comparison identifiers without mutation", async () => {
    await fetchApi(
      request("/api/briefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "brief-ambiguous",
          slug: "ambiguous",
          markdown: briefMarkdown,
        }),
      }),
    );
    const created = await fetchApi(
      request("/api/comparisons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: "brief-ambiguous", directions: 1 }),
      }),
    );
    const comparison = await created.json();
    const now = new Date().toISOString();
    database
      .query(
        `INSERT INTO comparisons (
          id, slug, title, source_brief_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        comparison.slug,
        "second-comparison",
        "Second comparison",
        "draft",
        now,
        now,
      );

    const response = await fetchApi(
      request("/api/variants/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          comparison: comparison.slug,
          direction: comparison.directions[0].id,
          engine: "taste",
          path: join(runRoot, "generated"),
        }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "comparison_conflict",
        message: `Comparison identifier '${comparison.slug}' is ambiguous`,
      },
    });
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM variants")
        .get()?.count,
    ).toBe(0);
  });

  test("carries allowed-origin CORS headers on unavailable service errors", async () => {
    for (const path of [
      "/api/projects",
      "/api/projects/any/rounds",
      "/api/agent-sessions/any",
    ]) {
      const response = await fetchApi(request(path));
      expect(response.status).toBe(503);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
      expect(response.headers.get("Vary")).toBe("Origin");
      expect((await response.json()).error.code).toBe("studio_unavailable");
    }

    const agentUnavailable = await fetchApi(
      request("/api/agent-sessions/any/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      }),
    );
    expect(agentUnavailable.status).toBe(503);
    expect(agentUnavailable.headers.get("Access-Control-Allow-Origin")).toBe(
      ORIGIN,
    );
    expect((await agentUnavailable.json()).error.code).toBe(
      "agent_unavailable",
    );
  });

  test("does not import an arbitrary brief path through the HTTP API", async () => {
    const briefPath = join(runRoot, "untrusted-brief.md");
    await writeFile(briefPath, briefMarkdown);
    const response = await fetchApi(
      request("/api/comparisons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: briefPath, directions: 1 }),
      }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM briefs")
        .get()?.count,
    ).toBe(0);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM comparisons",
        )
        .get()?.count,
    ).toBe(0);
  });
});
