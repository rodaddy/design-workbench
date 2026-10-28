import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  createVariantFetchHandler,
  startVariantServer,
  VARIANT_TWEAK_BRIDGE_PATH,
} from "../../src/server/variant-server";

const variantsRoot = resolve(import.meta.dir, "../fixtures/variants");
const trustedOrigin = "http://127.0.0.1:4173";
const handler = createVariantFetchHandler({
  generatedVariantsRoot: variantsRoot,
  trustedOrigin,
  hostname: "127.0.0.1",
  port: 41_874,
});

describe("isolated variant server", () => {
  test("serves a contained variant index with restrictive iframe CSP", async () => {
    const response = await handler(
      new Request("http://127.0.0.1:41874/example/index.html"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(await response.text()).toContain("Isolated fixture variant");

    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("sandbox allow-scripts");
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).not.toContain("allow-forms");
    expect(policy).not.toContain("allow-top-navigation");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("navigate-to 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("child-src 'none'");
    expect(policy).toContain("worker-src 'none'");
    expect(policy).toContain("manifest-src 'none'");
    expect(policy).toContain(`frame-ancestors ${trustedOrigin}`);
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
  });

  test("allows each validated trusted app origin to embed variants", async () => {
    const multiOriginHandler = createVariantFetchHandler({
      generatedVariantsRoot: variantsRoot,
      trustedOrigins: ["http://127.0.0.1:4173", "http://127.0.0.1:5173"],
      hostname: "127.0.0.1",
      port: 41_874,
    });

    const response = await multiOriginHandler(
      new Request("http://127.0.0.1:41874/example/index.html"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors http://127.0.0.1:4173 http://127.0.0.1:5173",
    );
  });

  test("injects the reserved tweak bridge only when an adjacent manifest exists", async () => {
    const tweakable = await handler(
      new Request("http://127.0.0.1:41874/example/index.html"),
    );
    const tweakableHtml = await tweakable.text();
    expect(tweakableHtml).toContain(
      `${VARIANT_TWEAK_BRIDGE_PATH}?variant=example`,
    );
    expect(tweakableHtml).toContain("data-workbench-tweak-bridge");

    const unconfigured = await handler(
      new Request("http://127.0.0.1:41874/security/index.html"),
    );
    expect(await unconfigured.text()).not.toContain(
      "data-workbench-tweak-bridge",
    );
  });

  test("serves a manifest-bound bridge script from the reserved endpoint", async () => {
    const response = await handler(
      new Request(
        `http://127.0.0.1:41874${VARIANT_TWEAK_BRIDGE_PATH}?variant=example`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const source = await response.text();
    expect(source).toContain('"variantId":"example"');
    expect(source).toContain(`"${trustedOrigin}"`);
    expect(source).toContain('"property":"--fixture-accent"');
  });

  test("rejects ambiguous bridge requests and missing manifests", async () => {
    const ambiguous = await handler(
      new Request(
        `http://127.0.0.1:41874${VARIANT_TWEAK_BRIDGE_PATH}?variant=example&selector=body`,
      ),
    );
    expect(ambiguous.status).toBe(400);

    const missing = await handler(
      new Request(
        `http://127.0.0.1:41874${VARIANT_TWEAK_BRIDGE_PATH}?variant=security`,
      ),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: {
        code: "not_found",
        message: "Variant tweak manifest not found",
      },
    });
  });

  test.each([
    "http://127.0.0.1:41874/%2e%2e%2fsecret.html",
    "http://127.0.0.1:41874/example%2f..%2fsecret.html",
  ])("rejects encoded traversal: %s", async (url) => {
    const response = await handler(new Request(url));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_path",
        message: "Requested variant path is invalid",
      },
    });
  });

  test("returns stable JSON for missing variants", async () => {
    const response = await handler(
      new Request("http://127.0.0.1:41874/example/missing.js"),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Variant file not found" },
    });
  });

  test("starts on a separate ephemeral origin without auto-starting on import", async () => {
    const server = startVariantServer({
      generatedVariantsRoot: variantsRoot,
      trustedOrigin,
      hostname: "127.0.0.1",
      port: 0,
    });
    try {
      const response = await fetch(`${server.url}example/style.css`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/css; charset=utf-8",
      );
      expect(await response.text()).toContain("rgb(20 20 20)");
    } finally {
      server.stop(true);
    }
  });
});
