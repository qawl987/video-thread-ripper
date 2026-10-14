import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const banner = await readFile(resolve(root, "src/banner.txt"), "utf8");
const mp4boxLicense = await readFile(resolve(root, "node_modules/mp4box/LICENSE"), "utf8");
const output = resolve(root, "dist/rule34video-thread-ripper.user.js");

await mkdir(dirname(output), { recursive: true });
await build({
  entryPoints: [resolve(root, "src/main.js")],
  outfile: output,
  bundle: true,
  format: "iife",
  target: "es2022",
  legalComments: "eof",
  banner: { js: banner.trimEnd() },
  minify: true,
});

const built = await readFile(output, "utf8");
const notice = `\n/*\nBundled dependency: MP4Box.js 2.4.1 (BSD-3-Clause)\n+${mp4boxLicense.trim()}\n*/\n`;
await writeFile(output, built.replace(/\r\n/g, "\n") + notice.replace(/\r\n/g, "\n"), "utf8");
console.log(`Built ${output}`);
