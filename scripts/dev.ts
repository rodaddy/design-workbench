import { createServer } from "node:net";

async function availablePort(excluded: ReadonlySet<number>): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer();
      server.unref();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("Unable to allocate a local development port"));
          return;
        }
        server.close((error) => {
          if (error) reject(error);
          else resolvePort(address.port);
        });
      });
    });
    if (!excluded.has(port)) return port;
  }
}

const selected = new Set<number>();
const appPort = await availablePort(selected);
selected.add(appPort);
const variantPort = await availablePort(selected);
selected.add(variantPort);
const vitePort = await availablePort(selected);

const appOrigin = `http://127.0.0.1:${appPort}`;
const variantOrigin = `http://127.0.0.1:${variantPort}`;
const viteOrigin = `http://127.0.0.1:${vitePort}`;
const trustedOrigins = [
  viteOrigin,
  `http://localhost:${vitePort}`,
  appOrigin,
].join(",");

console.info(`Design Workbench: ${viteOrigin}`);
console.info(`App/API: ${appOrigin}`);
console.info(`Variants: ${variantOrigin}`);

const children = [
  Bun.spawn(["bun", "--watch", "src/server/index.ts"], {
    env: {
      ...Bun.env,
      PORT: String(appPort),
      VARIANT_PORT: String(variantPort),
      TRUSTED_ORIGINS: trustedOrigins,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn(["bun", "run", "vite"], {
    env: {
      ...Bun.env,
      VITE_DEV_PORT: String(vitePort),
      VITE_API_ORIGIN: appOrigin,
      VITE_VARIANT_ORIGIN: variantOrigin,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
];

let stopping = false;
function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

const results = children.map(async (child) => ({
  child,
  code: await child.exited,
}));
const first = await Promise.race(results);
stop("SIGTERM");
await Promise.allSettled(results);
if (first.code !== 0) {
  console.error(`Development child exited with status ${first.code}`);
}
process.exit(first.code === 0 ? 0 : first.code);
