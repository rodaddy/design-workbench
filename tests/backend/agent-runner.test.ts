import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  LocalAgentError,
  LocalAgentRunner,
  parseLocalAgentLine,
} from "../../src/server/agent-runner";

const root = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/agent-runner-tests",
  `${process.pid}-${Date.now()}`,
);
const archive = resolve(
  (process.env.TMPDIR ?? "/tmp") +
    "/design-workbench/agent-runner-tests/_archive",
);
const reviewRoot = resolve(root, "review");
const buildRoot = resolve(root, "build");
const executable = resolve(root, "fake-agent");
const argvFile = resolve(root, "argv.json");

mkdirSync(reviewRoot, { recursive: true });
mkdirSync(buildRoot, { recursive: true });
writeFileSync(
  executable,
  `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
await Bun.write(${JSON.stringify(argvFile)}, JSON.stringify(args));
const prompt = args.at(-1) ?? "";
if (prompt === "timeout" || prompt === "active") await Bun.sleep(1500);
if (prompt === "malformed") {
  process.stdout.write("not-json\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({type:"system", session_id:"session"}) + "\\n");
process.stdout.write(JSON.stringify({type:"stream_event", event:{delta:{text:"hello "}}}) + "\\n");
process.stdout.write(JSON.stringify({type:"result", result:"world"}) + "\\n");
`,
);
chmodSync(executable, 0o755);

function runner() {
  return new LocalAgentRunner({
    executable,
    reviewRoots: [reviewRoot],
    buildRoots: [buildRoot],
  });
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: crypto.randomUUID(),
    prompt: "review this",
    cwd: reviewRoot,
    resume: false,
    mode: "review" as const,
    model: "fable",
    effort: "high" as const,
    timeoutMs: 5_000,
    maxOutputBytes: 64_000,
    ...overrides,
  };
}

function expectCode(error: unknown, code: LocalAgentError["code"]) {
  expect(error).toBeInstanceOf(LocalAgentError);
  expect((error as LocalAgentError).code).toBe(code);
}

afterAll(() => {
  mkdirSync(archive, { recursive: true });
  if (existsSync(root)) {
    renameSync(
      root,
      resolve(archive, `run-${Date.now()}-${crypto.randomUUID()}`),
    );
  }
});

describe("local Claude Code runner", () => {
  test("builds a first-turn read-only argv without shell interpolation", async () => {
    const result = await runner().run(
      request({ prompt: "$(touch /tmp/nope); hello" }),
    );
    expect(result.text).toContain("hello world");
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    expect(argv).toContain("--session-id");
    expect(argv).toContain("--verbose");
    expect(argv).toContain("--system-prompt");
    expect(argv).not.toContain("--include-partial-messages");
    expect(argv).not.toContain("--resume");
    expect(argv).toContain("plan");
    expect(argv.at(-2)).toBe("--");
    expect(argv.at(-1)).toBe("$(touch /tmp/nope); hello");
  });

  test("uses resume and build permissions only in an owned build directory", async () => {
    const sessionId = crypto.randomUUID();
    await runner().run(
      request({
        sessionId,
        prompt: "build",
        cwd: buildRoot,
        mode: "build",
        resume: true,
      }),
    );
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    expect(argv).toContain("--resume");
    expect(argv).not.toContain("--session-id");
    expect(argv).toContain("acceptEdits");
  });

  test("rejects working directories outside configured roots", async () => {
    try {
      await runner().run(request({ cwd: root }));
      throw new Error("Expected path rejection");
    } catch (error) {
      expectCode(error, "AGENT_PATH_FORBIDDEN");
    }
  });

  test("rejects malformed stream output", async () => {
    try {
      await runner().run(request({ prompt: "malformed" }));
      throw new Error("Expected malformed stream rejection");
    } catch (error) {
      expectCode(error, "AGENT_STREAM_INVALID");
    }
  });

  test("times out and releases the session lock", async () => {
    const instance = runner();
    const sessionId = crypto.randomUUID();
    try {
      await instance.run(
        request({ sessionId, prompt: "timeout", timeoutMs: 1_000 }),
      );
      throw new Error("Expected timeout");
    } catch (error) {
      expectCode(error, "AGENT_TIMEOUT");
    }
    expect(
      await instance.run(request({ sessionId, prompt: "retry after timeout" })),
    ).toMatchObject({ exitCode: 0 });
  });

  test("cancels a run and blocks concurrent turns for one session", async () => {
    const instance = runner();
    const sessionId = crypto.randomUUID();
    const controller = new AbortController();
    const active = instance.run(request({ sessionId, prompt: "active" }), {
      signal: controller.signal,
    });
    await Bun.sleep(25);
    try {
      await instance.run(request({ sessionId }));
      throw new Error("Expected active-run rejection");
    } catch (error) {
      expectCode(error, "AGENT_ACTIVE");
    }
    controller.abort();
    try {
      await active;
      throw new Error("Expected cancellation");
    } catch (error) {
      expectCode(error, "AGENT_CANCELLED");
    }
  });
});

describe("local agent stream parser", () => {
  test("extracts partial and final text", () => {
    expect(
      parseLocalAgentLine(
        JSON.stringify({
          type: "stream_event",
          event: { delta: { text: "part" } },
        }),
      ),
    ).toMatchObject({ text: "part", final: false });
    expect(
      parseLocalAgentLine(JSON.stringify({ type: "result", result: "done" })),
    ).toMatchObject({ text: "done", final: true });
  });
});
