import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAppFetchHandler } from "../../src/server/app-server";
import { migrateDatabase } from "../../src/server/database";
import { startServers } from "../../src/server/index";

const TEMP_ROOT = (process.env.TMPDIR ?? "/tmp") + "/design-workbench";
const ARCHIVE_ROOT = join(TEMP_ROOT, "_archive");
const CLIENT_HTML =
  '<meta name="variant-origin" content="http://127.0.0.1:3001" />';
let runRoot = "";
let database: Database;

beforeEach(async () => {
  await mkdir(ARCHIVE_ROOT, { recursive: true });
  runRoot = await mkdtemp(join(TEMP_ROOT, "app-server-test-"));
  for (const directory of ["captures", "assets", "generated", "dist"]) {
    await mkdir(join(runRoot, directory));
  }
  await mkdir(join(runRoot, "dist", "assets"));
  database = new Database(":memory:", { strict: true });
  migrateDatabase(database);
});

afterEach(async () => {
  database.close();
  await rename(
    runRoot,
    join(ARCHIVE_ROOT, `${Date.now()}-${crypto.randomUUID()}`),
  );
});

function handler(mode: "development" | "production") {
  return createAppFetchHandler({
    api: {
      database,
      assetRoot: join(runRoot, "assets"),
      generatedVariantsRoot: join(runRoot, "generated"),
      allowedOrigins: ["http://127.0.0.1:5173"],
    },
    capturesRoot: join(runRoot, "captures"),
    assetRoot: join(runRoot, "assets"),
    distRoot: join(runRoot, "dist"),
    mode,
    variantOrigin: "http://127.0.0.1:3001",
    port: 0,
  });
}

describe("application server", () => {
  test("delegates capture serving and rejects traversal", async () => {
    await writeFile(join(runRoot, "captures", "proof.txt"), "proof");
    const fetch = handler("development");
    expect(
      await (
        await fetch(new Request("http://app.test/captures/proof.txt"))
      ).text(),
    ).toBe("proof");
    expect(
      (await fetch(new Request("http://app.test/captures/%2e%2e%2fsecret")))
        .status,
    ).toBe(400);
  });

  test("leaves client serving to Vite in development", async () => {
    const response = await handler("development")(
      new Request("http://app.test/library"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("client_not_served");
  });

  test("serves a Vite production layout, uploaded assets, and SPA routes", async () => {
    await writeFile(
      join(runRoot, "dist", "index.html"),
      `${CLIENT_HTML}<script type="module" src="/assets/index-a1b2.js"></script>`,
    );
    await writeFile(
      join(runRoot, "dist", "assets", "index-a1b2.js"),
      "export const built = true",
    );
    await writeFile(join(runRoot, "assets", "uploaded.png"), "uploaded");
    const fetch = handler("production");
    expect(
      await (
        await fetch(new Request("http://app.test/assets/index-a1b2.js"))
      ).text(),
    ).toBe("export const built = true");
    expect(
      await (
        await fetch(new Request("http://app.test/assets/uploaded.png"))
      ).text(),
    ).toBe("uploaded");
    expect(
      await (await fetch(new Request("http://app.test/compare/one"))).text(),
    ).toContain("/assets/index-a1b2.js");
    const spa = await fetch(new Request("http://app.test/compare/one"));
    expect(spa.headers.get("content-security-policy")).toBe(
      "frame-src http://127.0.0.1:3001; child-src http://127.0.0.1:3001",
    );
    const builtAsset = await fetch(
      new Request("http://app.test/assets/index-a1b2.js"),
    );
    expect(builtAsset.headers.get("content-security-policy")).not.toContain(
      "frame-src http://127.0.0.1:3001",
    );
  });

  test("fails loudly when the configured variant origin is not an exact HTTP origin", () => {
    expect(() =>
      createAppFetchHandler({
        api: {
          database,
          assetRoot: join(runRoot, "assets"),
          generatedVariantsRoot: join(runRoot, "generated"),
          allowedOrigins: ["http://127.0.0.1:5173"],
        },
        capturesRoot: join(runRoot, "captures"),
        assetRoot: join(runRoot, "assets"),
        distRoot: join(runRoot, "dist"),
        mode: "production",
        variantOrigin: "http://127.0.0.1:3001/variant",
        port: 0,
      }),
    ).toThrow("variantOrigin");
  });

  test("fails loudly when production HTML lacks the variant-origin marker", async () => {
    await writeFile(
      join(runRoot, "dist", "index.html"),
      "<main>Workbench</main>",
    );
    const response = await handler("production")(
      new Request("http://app.test/compare/one"),
    );
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe(
      "variant_origin_marker_missing",
    );
  });

  test("returns 404 for missing production asset-like paths instead of the SPA", async () => {
    await writeFile(
      join(runRoot, "dist", "index.html"),
      `${CLIENT_HTML}<main>Workbench</main>`,
    );
    const fetch = handler("production");
    const missing = await fetch(
      new Request("http://app.test/scripts/missing.js"),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: "not_found", message: "Client asset not found" },
    });
  });

  test("fails loudly when the production index is missing", async () => {
    await writeFile(
      join(runRoot, "dist", "index.html"),
      `${CLIENT_HTML}<main>Workbench</main>`,
    );
    const fetch = handler("production");
    await rename(
      join(runRoot, "dist", "index.html"),
      join(runRoot, "dist", "gone.html"),
    );
    const missing = await fetch(new Request("http://app.test/compare/two"));
    expect(missing.status).toBe(500);
    expect((await missing.json()).error.code).toBe("client_build_missing");
  });

  test("production defaults trust only the app origin for API and variant framing", async () => {
    const appProbe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const appPort = appProbe.port;
    appProbe.stop(true);
    const variantProbe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const variantPort = variantProbe.port;
    variantProbe.stop(true);
    await writeFile(
      join(runRoot, "dist", "index.html"),
      `${CLIENT_HTML}<main>App</main>`,
    );
    await writeFile(join(runRoot, "generated", "index.html"), "<main>V</main>");

    const running = startServers({
      HOST: "127.0.0.1",
      PORT: String(appPort),
      VARIANT_PORT: String(variantPort),
      NODE_ENV: "production",
      DATABASE_PATH: join(runRoot, "data", "production.sqlite"),
      ASSET_ROOT: join(runRoot, "assets"),
      CAPTURES_ROOT: join(runRoot, "captures"),
      GENERATED_VARIANTS_ROOT: join(runRoot, "generated"),
      DIST_ROOT: join(runRoot, "dist"),
    });
    try {
      const viteOrigin = await fetch(`http://127.0.0.1:${appPort}/api/health`, {
        headers: { Origin: "http://127.0.0.1:5173" },
      });
      expect(viteOrigin.status).toBe(403);
      const appOrigin = `http://127.0.0.1:${appPort}`;
      const trusted = await fetch(`http://127.0.0.1:${appPort}/api/health`, {
        headers: { Origin: appOrigin },
      });
      expect(trusted.status).toBe(200);
      const variant = await fetch(`http://127.0.0.1:${variantPort}/`);
      const csp = variant.headers.get("content-security-policy") ?? "";
      expect(csp).toContain(`frame-ancestors ${appOrigin}`);
      expect(csp).not.toContain("http://127.0.0.1:5173");
      const app = await fetch(`http://127.0.0.1:${appPort}/compare/one`);
      expect(app.headers.get("content-security-policy")).toBe(
        `frame-src http://127.0.0.1:${variantPort}; child-src http://127.0.0.1:${variantPort}`,
      );
      expect(await app.text()).toContain(
        `<meta name="variant-origin" content="http://127.0.0.1:${variantPort}" />`,
      );
    } finally {
      running.app.stop(true);
      running.variant.stop(true);
      running.database.close(false);
    }
  });

  test("stops the app server when variant startup fails", () => {
    const appProbe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const appPort = appProbe.port;
    appProbe.stop(true);
    const occupiedVariant = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    expect(() =>
      startServers({
        HOST: "127.0.0.1",
        PORT: String(appPort),
        VARIANT_PORT: String(occupiedVariant.port),
        NODE_ENV: "development",
        DATABASE_PATH: join(runRoot, "data", "rollback.sqlite"),
        ASSET_ROOT: join(runRoot, "assets"),
        CAPTURES_ROOT: join(runRoot, "captures"),
        GENERATED_VARIANTS_ROOT: join(runRoot, "generated"),
        DIST_ROOT: join(runRoot, "dist"),
      }),
    ).toThrow();
    const rebound = Bun.serve({
      hostname: "127.0.0.1",
      port: appPort,
      fetch: () => new Response(),
    });
    rebound.stop(true);
    occupiedVariant.stop(true);
  });
});
