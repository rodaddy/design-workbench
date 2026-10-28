import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createCaptureFetchHandler } from "../../src/server/static-files";

const TEMP_ROOT = (process.env.TMPDIR ?? "/tmp") + "/design-workbench";
const ARCHIVE_ROOT = join(TEMP_ROOT, "_archive");
let runRoot = "";

beforeEach(async () => {
  await mkdir(ARCHIVE_ROOT, { recursive: true });
  runRoot = await mkdtemp(join(TEMP_ROOT, "static-files-test-"));
});

afterEach(async () => {
  if (runRoot.length > 0) {
    await rename(
      runRoot,
      join(ARCHIVE_ROOT, `${Date.now()}-${crypto.randomUUID()}`),
    );
    runRoot = "";
  }
});

describe("capture static files", () => {
  test("serves only files beneath the configured captures root", async () => {
    const capturesRoot = join(runRoot, "captures");
    await mkdir(capturesRoot);
    await writeFile(join(capturesRoot, "example.txt"), "capture evidence");
    const fetch = createCaptureFetchHandler({ capturesRoot });

    const response = await fetch(
      new Request("http://trusted.test/captures/example.txt"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await response.text()).toBe("capture evidence");
  });

  test("serves hostile HTML as an inert attachment", async () => {
    const capturesRoot = join(runRoot, "captures");
    await mkdir(capturesRoot);
    await writeFile(
      join(capturesRoot, "hostile.html"),
      "<script>fetch('/api/briefs')</script>",
    );
    const fetch = createCaptureFetchHandler({ capturesRoot });

    const response = await fetch(
      new Request("http://trusted.test/captures/hostile.html"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test.each([
    "http://trusted.test/captures/%2e%2e%2fsecret.txt",
    "http://trusted.test/captures/folder%2f..%2fsecret.txt",
    "http://trusted.test/captures/%00secret.txt",
  ])("rejects traversal input: %s", async (url) => {
    const capturesRoot = join(runRoot, "captures");
    await mkdir(capturesRoot);
    const fetch = createCaptureFetchHandler({ capturesRoot });

    const response = await fetch(new Request(url));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_path", message: "Requested path is invalid" },
    });
  });

  test("rejects a symlink whose canonical target escapes captures", async () => {
    const capturesRoot = join(runRoot, "captures");
    const outsideRoot = join(runRoot, "outside");
    await mkdir(capturesRoot);
    await mkdir(outsideRoot);
    await writeFile(join(outsideRoot, "secret.txt"), "not capture evidence");
    await symlink(
      join(outsideRoot, "secret.txt"),
      join(capturesRoot, "escape.txt"),
    );
    const fetch = createCaptureFetchHandler({ capturesRoot });

    const response = await fetch(
      new Request("http://trusted.test/captures/escape.txt"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_path", message: "Requested path is invalid" },
    });
  });

  test("returns a stable missing-file response", async () => {
    const capturesRoot = join(runRoot, "captures");
    await mkdir(capturesRoot);
    const fetch = createCaptureFetchHandler({ capturesRoot });

    const response = await fetch(
      new Request("http://trusted.test/captures/missing.png"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "File not found" },
    });
  });
});
