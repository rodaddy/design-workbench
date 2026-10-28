import { defineConfig } from "vite";

const apiOrigin = process.env.VITE_API_ORIGIN ?? "http://127.0.0.1:0";
export const DEV_VARIANT_ORIGIN =
  process.env.VITE_VARIANT_ORIGIN ?? "http://127.0.0.1:0";
export const DEV_PARENT_CSP = [
  `frame-src ${DEV_VARIANT_ORIGIN}`,
  `child-src ${DEV_VARIANT_ORIGIN}`,
].join("; ");

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  plugins: [
    {
      name: "design-workbench-runtime-origin",
      transformIndexHtml(html) {
        return html.replace(
          /<meta\s+name=(["'])variant-origin\1\s+content=(["'])[^"']*\2\s*\/?>/i,
          `<meta name="variant-origin" content="${DEV_VARIANT_ORIGIN}" />`,
        );
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.VITE_DEV_PORT ?? "0"),
    strictPort: true,
    headers: {
      "Content-Security-Policy": DEV_PARENT_CSP,
    },
    proxy: {
      "/api": apiOrigin,
      "/assets": apiOrigin,
      "/captures": apiOrigin,
    },
  },
});
