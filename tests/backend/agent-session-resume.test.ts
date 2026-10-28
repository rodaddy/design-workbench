import { Database } from "bun:sqlite";
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

import { createApiFetchHandler } from "../../src/server/api";
import { LocalAgentRunner } from "../../src/server/agent-runner";
import { migrateDatabase } from "../../src/server/database";
import { StudioProjectStore } from "../../src/server/projects";
import { StudioService } from "../../src/server/studio";

const ORIGIN = "http://127.0.0.1:5173";
const root = resolve(
  (process.env.TMPDIR ?? "/tmp") + "/design-workbench/agent-resume-tests",
  `${process.pid}-${Date.now()}`,
);
const archive = resolve(
  (process.env.TMPDIR ?? "/tmp") +
    "/design-workbench/agent-resume-tests/_archive",
);

afterAll(() => {
  mkdirSync(archive, { recursive: true });
  if (existsSync(root)) {
    renameSync(
      root,
      resolve(archive, `run-${Date.now()}-${crypto.randomUUID()}`),
    );
  }
});

// A fake `claude` executable. It records whether it was invoked with `--resume`
// or `--session-id` into a log file inside its working directory, then fails
// once if a `fail-marker` file is present (removing the marker afterwards) so a
// first failed run can be followed by a successful retry.
function writeFakeAgent(path: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env bun
import { existsSync, appendFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
const args = process.argv.slice(2);
const mode = args.includes("--resume") ? "resume" : "fresh";
appendFileSync(resolve(process.cwd(), "agent-invocations.log"), mode + "\\n");
const marker = resolve(process.cwd(), "fail-marker");
if (existsSync(marker)) {
  unlinkSync(marker);
  process.exit(1);
}
process.stdout.write(JSON.stringify({ type: "result", result: "ok" }) + "\\n");
`,
  );
  chmodSync(path, 0o755);
}

function invocations(cwd: string): string[] {
  const log = resolve(cwd, "agent-invocations.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
}

function fixture() {
  const run = resolve(root, crypto.randomUUID());
  const allowed = resolve(run, "allowed");
  const source = resolve(allowed, "site");
  const runtime = resolve(run, "runtime");
  const executable = resolve(run, "fake-agent");
  mkdirSync(source, { recursive: true });
  writeFileSync(resolve(source, "index.html"), "<h1>Baseline</h1>\n");
  writeFakeAgent(executable);

  const database = new Database(":memory:", { strict: true });
  migrateDatabase(database);
  const projects = new StudioProjectStore(database, {
    allowedSourceRoots: [allowed],
    runtimeRoot: runtime,
  });
  const project = projects.createProject({
    slug: "resume-site",
    title: "Resume Site",
    sourcePath: source,
    idempotencyKey: "resume-site",
  });
  const studio = new StudioService(database);
  const session = studio.createSession(project.id, {
    roundId: null,
    metadata: {},
    idempotencyKey: "resume-session",
  });
  const runner = new LocalAgentRunner({
    executable,
    reviewRoots: [runtime],
    buildRoots: [runtime],
  });
  const handler = createApiFetchHandler({
    database,
    assetRoot: allowed,
    generatedVariantsRoot: allowed,
    allowedOrigins: [ORIGIN],
    projectStorage: { allowedSourceRoots: [allowed], runtimeRoot: runtime },
    agentRunner: runner,
  });
  return { database, handler, project, runtime, session };
}

function message(sessionId: string, text: string): Request {
  return new Request(
    `http://127.0.0.1:3000/api/agent-sessions/${sessionId}/messages`,
    {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    },
  );
}

describe("local agent session resume", () => {
  test("only resumes after a prior run has actually completed", async () => {
    const { database, handler, project, runtime, session } = fixture();
    const cwd = resolve(runtime, `projects/${project.id}`);

    // First run fails. It must be started fresh, and its failure must not be
    // treated as a resumable session.
    writeFileSync(resolve(cwd, "fail-marker"), "");
    const failed = await handler(message(session.id, "first attempt"));
    expect(failed.status).toBe(502);
    expect(invocations(cwd)).toEqual(["fresh"]);

    // Retry after the failure. Persisted user messages exist, but no run has
    // completed, so this must still be a fresh (non-resume) invocation.
    const retry = await handler(message(session.id, "retry attempt"));
    expect(retry.status).toBe(200);
    expect(invocations(cwd)).toEqual(["fresh", "fresh"]);

    // A completed run now exists, so the next message resumes it.
    const resumed = await handler(message(session.id, "third attempt"));
    expect(resumed.status).toBe(200);
    expect(invocations(cwd)).toEqual(["fresh", "fresh", "resume"]);

    database.close();
  });
});
