import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VARIANT_IFRAME_SANDBOX } from "../../src/client/components/compare/isolation";
import { createVariantFetchHandler } from "../../src/server/variant-server";
import viteConfig, {
  DEV_PARENT_CSP,
  DEV_VARIANT_ORIGIN,
} from "../../vite.config";

const fixtureRoot = resolve(import.meta.dir, "../fixtures/variants");
const trustedOrigin = "http://127.0.0.1:4173";
const handler = createVariantFetchHandler({
  generatedVariantsRoot: fixtureRoot,
  trustedOrigin,
  hostname: "127.0.0.1",
  port: 41_874,
});

describe("variant isolation contract", () => {
  test("Vite constrains child-frame navigation to the isolated development origin", () => {
    expect(DEV_VARIANT_ORIGIN).toBe("http://127.0.0.1:0");
    expect(DEV_PARENT_CSP).toBe(
      "frame-src http://127.0.0.1:0; child-src http://127.0.0.1:0",
    );
    expect(viteConfig.server?.headers).toMatchObject({
      "Content-Security-Policy": DEV_PARENT_CSP,
    });
    expect(
      readFileSync(resolve(import.meta.dir, "../../index.html"), "utf8"),
    ).toContain(
      `<meta name="variant-origin" content="${DEV_VARIANT_ORIGIN}" />`,
    );
  });

  test("the adversarial fixture exercises every prohibited behavior class", () => {
    const fixture = readFileSync(
      resolve(fixtureRoot, "security/index.html"),
      "utf8",
    );
    expect(fixture).toContain("window.parent.document.cookie");
    expect(fixture).toContain("127.0.0.1:4173/api/comparisons");
    expect(fixture).toContain("example.com/variant-exfiltration");
    expect(fixture).toContain('target="_top"');
    expect(fixture).toContain("window.top.location.assign");
  });

  test("server CSP and iframe sandbox deny parent, network, form, and navigation capabilities", async () => {
    const response = await handler(
      new Request("http://127.0.0.1:41874/security/index.html", {
        headers: { Origin: trustedOrigin },
      }),
    );
    expect(response.status).toBe(200);
    const policy = response.headers.get("content-security-policy") ?? "";

    expect(VARIANT_IFRAME_SANDBOX).toBe("allow-scripts");
    expect(VARIANT_IFRAME_SANDBOX).not.toContain("allow-same-origin");
    expect(VARIANT_IFRAME_SANDBOX).not.toContain("allow-forms");
    expect(VARIANT_IFRAME_SANDBOX).not.toContain("allow-top-navigation");
    expect(policy).toContain("sandbox allow-scripts");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("navigate-to 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("worker-src 'none'");
    expect(policy).toContain(`frame-ancestors ${trustedOrigin}`);
    expect(policy).not.toContain("allow-same-origin");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      trustedOrigin,
    );
  });

  test.todo(
    "a real browser blocks hostile self-frame navigation at the trusted parent CSP",
    () => {},
  );

  test("CORS permits trusted availability probes without opening the variant origin broadly", async () => {
    const trusted = await handler(
      new Request("http://127.0.0.1:41874/security/index.html", {
        method: "HEAD",
        headers: { Origin: trustedOrigin },
      }),
    );
    expect(trusted.status).toBe(200);
    expect(trusted.headers.get("access-control-allow-origin")).toBe(
      trustedOrigin,
    );

    const untrusted = await handler(
      new Request("http://127.0.0.1:41874/security/index.html", {
        method: "HEAD",
        headers: { Origin: "https://example.com" },
      }),
    );
    expect(untrusted.status).toBe(200);
    expect(untrusted.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("the fixture proof set has multiple directions and both engines, all serveable", async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(fixtureRoot, "comparison-fixture.json"), "utf8"),
    ) as {
      directions: Array<{ slug: string; engines: string[] }>;
    };
    expect(manifest.directions.length).toBeGreaterThanOrEqual(2);

    for (const direction of manifest.directions) {
      expect(direction.engines).toEqual(["impeccable", "taste"]);
      for (const engine of direction.engines) {
        const response = await handler(
          new Request(
            `http://127.0.0.1:41874/comparison/${direction.slug}/${engine}/index.html`,
          ),
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("FIXTURE");
      }
    }
  });
});
