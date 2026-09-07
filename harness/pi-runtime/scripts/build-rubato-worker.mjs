// Bun is a build tool only. Runtime imports are emitted relative to the selected
// stock tree, so neither workspace aliases nor a globally installed Senpi leak in.
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "@babel/parser";

const config = JSON.parse(await Bun.stdin.text());
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const portable = (path) => path.replaceAll("\\", "/");
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const bundles = [];
const sources = new Map();
const externalImports = new Set();

function inside(parent, path) {
  const rel = relative(parent, path);
  return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel);
}

function targetExport(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["import", "node", "default"]) {
    const target = targetExport(value[key]);
    if (target) return target;
  }
}

async function workspaceImport(specifier) {
  const name = specifier.split("/").slice(0, 2).join("/");
  const pkg = config.workspace[name];
  if (!pkg) throw new Error(`Undeclared workspace package: ${specifier}`);
  const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
  // This package publishes built files; build from the current source instead.
  if (name === "@rubato/lsp-daemon" && subpath === "./client") return join(pkg.root, "src/client.ts");
  let target = targetExport(subpath === "." && typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.[subpath]);
  if (!target) {
    for (const key of Object.keys(pkg.exports ?? {}).filter((key) => key.includes("*")).sort((a, b) => b.length - a.length)) {
      const [prefix, suffix] = key.split("*");
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
      const replacement = subpath.slice(prefix.length, suffix ? -suffix.length : undefined);
      target = targetExport(pkg.exports[key])?.replaceAll("*", replacement);
      if (target) break;
    }
  }
  if (!target) throw new Error(`Missing workspace export: ${specifier}`);
  const path = resolve(pkg.root, target);
  if (!inside(pkg.root, path)) throw new Error(`Workspace export escaped package: ${specifier}`);
  return path;
}

async function stockImport(specifier, outputPath) {
  let mapped = specifier.replace(/^@code-yeongyu\/senpi(?=\/|$)/, "@earendil-works/pi-coding-agent")
    .replace(/^@mariozechner\//, "@earendil-works/");
  const name = mapped.split("/").slice(0, 2).join("/");
  const pkg = config.stockPackages[name];
  if (!pkg) throw new Error(`Unselected stock package: ${specifier}`);
  let entry = pkg.entry;
  if (mapped !== name) {
    const manifest = JSON.parse(await readFile(pkg.packageJsonPath, "utf8"));
    const target = targetExport(manifest.exports?.[`.${mapped.slice(name.length)}`]);
    if (!target) throw new Error(`Stock public export unavailable: ${mapped}`);
    entry = resolve(pkg.dir, target);
  }
  if (!inside(pkg.dir, await realpath(entry))) throw new Error(`Stock export escaped package: ${mapped}`);
  const stagedBundle = join(config.sourceRoot, "rubato-features/rubato-components", outputPath);
  const path = portable(relative(dirname(stagedBundle), entry));
  externalImports.add(mapped);
  return { path: path.startsWith(".") ? path : `./${path}`, external: true };
}

for (const [outputPath, entryPath] of Object.entries(config.entries)) {
  const result = await Bun.build({
    entrypoints: [join(config.repoRoot, entryPath)], target: "node", format: "esm", env: "disable",
    root: config.repoRoot, minify: { syntax: true, whitespace: true, identifiers: false }, metafile: true,
    define: { RUBATO_MEMBER_BUNDLE: JSON.stringify("rubato-member.js"), RUBATO_MEMORY_MCP_BUNDLE: JSON.stringify("rubato-memory-mcp.js") },
    plugins: [{ name: "rubato-stock-boundary", setup(builder) {
      builder.onLoad({ filter: /\.(?:[cm]?[jt]sx?|json)$/ }, async ({ path }) => {
        const resolved = await realpath(path);
        if (!inside(config.repoRoot, resolved) && !inside(join(config.sourceRoot, "node_modules"), resolved)) {
          throw new Error(`Bundle source escaped workspace: ${path}`);
        }
        const contents = await readFile(resolved);
        const key = portable(relative(config.repoRoot, resolved));
        const hash = sha256(contents);
        if (sources.has(key) && sources.get(key) !== hash) throw new Error(`Bundle source changed during build: ${key}`);
        sources.set(key, hash);
        const extension = path.split(".").at(-1);
        const loader = extension === "json" ? "json" : extension === "tsx" ? "tsx" : extension === "jsx" ? "jsx" : /^(?:[cm]?ts)$/.test(extension) ? "ts" : "js";
        return { contents, loader };
      });
      builder.onResolve({ filter: /^[^./]|^\.\.?$/ }, async (args) => {
        const specifier = args.path;
        if (isAbsolute(specifier)) return undefined;
        if (builtins.has(specifier) || specifier.startsWith("node:")) return { path: specifier.startsWith("node:") ? specifier : `node:${specifier}`, external: true };
        if (specifier === "#rubato-task-runtime") return { path: specifier, external: true };
        if (specifier.startsWith("@rubato/")) return { path: await workspaceImport(specifier) };
        if (/^@(earendil-works|mariozechner)\//.test(specifier) || specifier.startsWith("@code-yeongyu/senpi")) return stockImport(specifier, outputPath);
        const normalized = specifier.replace(/^@sinclair\/typebox(?=\/|$)/, "typebox");
        if (/^typebox(?:\/|$)/.test(normalized)) { externalImports.add(normalized); return { path: normalized, external: true }; }
        const resolved = await realpath(Bun.resolveSync(normalized, join(config.sourceRoot, "package.json")));
        if (!inside(join(config.sourceRoot, "node_modules"), resolved)) throw new Error(`Build dependency escaped isolated runtime: ${specifier}`);
        return { path: resolved };
      });
    } }],
  });
  if (!result.success) throw new AggregateError(result.logs, `Failed bundle ${outputPath}`);
  if (result.outputs.length !== 1) throw new Error(`Unexpected split/asset output for ${outputPath}`);
  // Bun 1.4 preserves the original specifier for some external onResolve
  // results. Rewrite only parsed module-specifier literals, never source text
  // or arbitrary strings. This also makes emitted imports auditable.
  let body = await result.outputs[0].text();
  const ast = parse(body, { sourceType: "module", createImportExpressions: true });
  const replacements = [];
  const pending = [ast.program];
  while (pending.length) {
    const node = pending.pop();
    const literal = ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type) ? node.source : undefined;
    if (literal?.type === "StringLiteral" && (/^@(earendil-works|mariozechner)\//.test(literal.value) || literal.value.startsWith("@code-yeongyu/senpi"))) {
      const mapped = await stockImport(literal.value, outputPath);
      replacements.push({ start: literal.start, end: literal.end, text: JSON.stringify(mapped.path) });
    }
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end", "extra", "comments", "tokens"].includes(key)) continue;
      if (Array.isArray(value)) for (const child of value) { if (child?.type) pending.push(child); }
      else if (value?.type) pending.push(value);
    }
  }
  for (const change of replacements.sort((a, b) => b.start - a.start)) body = body.slice(0, change.start) + change.text + body.slice(change.end);
  const bytes = Buffer.from(body);
  const target = join(config.outputRoot, outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: "wx", mode: outputPath.includes("/cli.js") ? 0o755 : 0o644 });
  bundles.push({ path: outputPath, entry: entryPath, sha256: sha256(bytes), bytes: bytes.length });
  for (const input of Object.keys(result.metafile?.inputs ?? {})) {
    const path = resolve(config.repoRoot, input);
    if (!inside(config.repoRoot, path) && !inside(join(config.sourceRoot, "node_modules"), path)) throw new Error(`Bundle source escaped workspace: ${input}`);
    const key = portable(relative(config.repoRoot, await realpath(path)));
    const hash = sha256(await readFile(path));
    if (sources.get(key) !== hash) throw new Error(`Bundle input was not snapshotted or changed: ${input}`);
  }
}
process.stdout.write(JSON.stringify({ bundles, sources: [...sources].map(([path, sha256]) => ({ path, sha256 })),
  externalImports: [...externalImports].sort(), bunVersion: Bun.version }));
