import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const rootDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function resolveEsbuild() {
  const searchPaths = [
    rootDir,
    resolve(process.env.HOME ?? "", ".openclaw/npm"),
  ];

  for (const base of searchPaths) {
    try {
      return require.resolve("esbuild", { paths: [base] });
    } catch {
      // Try the next locally available tool location.
    }
  }

  throw new Error(
    "esbuild is required to build openclaw-wechat-plugin. Install it locally with: npm install --save-dev esbuild",
  );
}

const esbuild = await import(resolveEsbuild());

await mkdir(new URL("../dist", import.meta.url), { recursive: true });

await esbuild.build({
  entryPoints: [new URL("../index.ts", import.meta.url).pathname],
  outfile: new URL("../dist/index.js", import.meta.url).pathname,
  bundle: true,
  external: ["openclaw", "openclaw/*"],
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
});
