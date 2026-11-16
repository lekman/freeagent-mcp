/**
 * Build @lekman/freeagent with Bun, targeting Node.
 *
 * Dependencies are bundled (the package has none at runtime today), so a
 * consumer needs nothing but Node 20. `dist` is the only code that ships:
 * package.json deliberately omits `src` from `files`, unlike the toolkit's
 * other packages, because this one talks to an accounting system.
 */

import { chmodSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const outdir = join(root, "dist");

await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(root, "src/index.ts"), join(root, "src/bin/freeagent.ts")],
  outdir,
  target: "node",
  format: "esm",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
chmodSync(join(outdir, "bin/freeagent.js"), 0o755);

// Types, from tsc. Bun.build does not emit declarations, so without this
// step the published exports map points `types` at a file `files` does not
// ship: a TypeScript consumer gets no types and a Bun consumer cannot
// resolve the package at all. Verified by installing the tarball.
const types = Bun.spawnSync(["bunx", "tsc", "-p", "tsconfig.build.json"], {
  stdout: "inherit",
  stderr: "inherit",
});
if (types.exitCode !== 0) process.exit(types.exitCode ?? 1);

// rewriteRelativeImportExtensions is set and does nothing here: it rewrites
// JavaScript emit, and this run is emitDeclarationOnly. Checked with
// --showConfig, so the option is applied and simply does not cover .d.ts.
// Left alone, every declaration imports "./x/index.ts", which a consumer on
// moduleResolution nodenext rejects with TS2834 unless they have
// skipLibCheck on. Rewriting the extension here is the whole fix.
const declarations = new Bun.Glob("**/*.d.ts").scanSync(outdir);
let rewritten = 0;
for (const relative of declarations) {
  const file = join(outdir, relative);
  const before = await Bun.file(file).text();
  const after = before.replace(/(from\s+")(\.[^"]*)\.ts(")/g, "$1$2.js$3");
  if (after !== before) {
    await Bun.write(file, after);
    rewritten += 1;
  }
}

console.log(
  `built dist/index.js, dist/bin/freeagent.js, and declarations (${rewritten} rewritten)`,
);
