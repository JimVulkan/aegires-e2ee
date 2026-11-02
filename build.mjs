// Builds dist/index.js + dist/manifest.json with esbuild (works in Termux: `npm i` pulls the
// android-arm64 esbuild binary).
//
// Vendetta-style loaders evaluate a plugin as an EXPRESSION and expect it to return
// `{ default: { onLoad, onUnload, settings } }`, with a global `vendetta` object in scope.
// So we (1) bundle to CommonJS, (2) map every `@vendetta/x/y` import to the global
// `vendetta.x.y` instead of bundling it, and (3) wrap the result in a function expression
// that returns module.exports.
import { build } from "esbuild";
import { transformAsync } from "@babel/core";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const vendettaGlobals = {
  name: "vendetta-globals",
  setup(b) {
    b.onResolve({ filter: /^@vendetta\// }, (a) => ({ path: a.path, namespace: "vendetta" }));
    b.onLoad({ filter: /.*/, namespace: "vendetta" }, (a) => ({
      contents: `module.exports = ${a.path.slice(1).replace(/\//g, ".")};`,
      loader: "js",
    }));
  },
};

const minify = process.env.MINIFY === "1";

// The WebView crypto engine page runs in Chrome's engine, not Hermes: bundle it on its own and
// embed it in the plugin as a string (src/engine/engine.tsx wraps it in HTML).
const page = await build({
  entryPoints: ["src/engine/page.ts"],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2020",
  minify: true,
  logLevel: "warning",
});
const pageJs = page.outputFiles[0].text;

const result = await build({
  entryPoints: ["src/index.tsx"],
  bundle: true,
  write: false,
  format: "cjs",
  target: "es2020",
  minify,
  jsx: "transform",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  define: { "process.env.NODE_ENV": '"production"', __ENGINE_PAGE__: JSON.stringify(pageJs) },
  logLevel: "info",
  plugins: [vendettaGlobals],
});

// Hermes as Discord runs it gives let/const in loops ONE binding for the whole loop (like var),
// so closures created in a loop all see the last iteration's values. Discord's own bundle is
// compiled with Babel's block-scoping transform; do the same for ours (it creates a fresh
// binding per iteration where a closure needs one).
const body = (
  await transformAsync(result.outputFiles[0].text, {
    babelrc: false,
    configFile: false,
    compact: false,
    sourceType: "script",
    plugins: ["@babel/plugin-transform-block-scoping"],
  })
).code;
const code = `(function(){var module={exports:{}};var exports=module.exports;\n${body}\nreturn module.exports;})()\n`;

const manifest = JSON.parse(await readFile("src/manifest.json", "utf8"));
manifest.hash = createHash("sha256").update(code).digest("hex");

await mkdir("dist", { recursive: true });
await writeFile("dist/index.js", code);
await writeFile("dist/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
await writeFile("dist/.nojekyll", "");
console.log(`built dist/index.js (${(code.length / 1024).toFixed(0)} KB, engine page ${(pageJs.length / 1024).toFixed(0)} KB)${minify ? " [minified]" : ""}`);
