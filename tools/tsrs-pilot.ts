import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Run serially in a disposable checkout: these are real compiler boundary probes,
// not application tests. Finally restores original bytes on ordinary failures;
// SIGKILL/power loss cannot run cleanup, so never run beside another editor.
const compilers = ["tsc", "tsrs"] as const;
type Compiler = (typeof compilers)[number];
const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "hearth-tsrs-"));
const output = process.argv[2] ?? join(scratch, "report.json");
const args = ["--noEmit", "--pretty", "false", "--project"];

function normalize(text: string) {
  return text.replaceAll(`${root}/`, "").replaceAll("\r\n", "\n");
}

function run(compiler: Compiler, config: string, extra: string[] = []) {
  const result = spawnSync(`node_modules/.bin/${compiler}`, [...args, config, ...extra], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "", `${compiler} stderr`);
  assert.ok(result.status === 0 || result.status === 1 || result.status === 2, `${compiler} exit ${result.status}`);
  return { exit: result.status, stdout: normalize(result.stdout) };
}

function diagnostics(result: ReturnType<typeof run>) {
  // Sort whole multiline diagnostics, not individual lines: nesting and full
  // message text remain significant. Start positions and codes are not erased.
  const blocks: string[] = [];
  for (const line of result.stdout.trimEnd().split("\n")) {
    if (!line) continue;
    if (/^.+\(\d+,\d+\): error TS\d+: /.test(line) || /^error TS\d+: /.test(line)) {
      blocks.push(line);
    } else {
      assert.ok(/^\s/.test(line) && blocks.length > 0, `Unparsed output: ${line}`);
      blocks[blocks.length - 1] += `\n${line}`;
    }
  }
  return { exit: result.exit, diagnostics: blocks.sort() };
}

function pair(config: string) {
  return { tsc: diagnostics(run("tsc", config)), tsrs: diagnostics(run("tsrs", config)) };
}

function coverage(config: string) {
  const lists = compilers.map((compiler) => {
    const result = run(compiler, config, ["--listFilesOnly"]);
    assert.equal(result.exit, 0);
    return result.stdout.trim().split("\n").map((path) =>
      path.replace(/^node_modules\/(?:typescript\/lib|@typescript\/typescript-[^/]+\/lib|@tsrs\/[^/]+)\/(lib\.[^/]+\.d\.ts)$/, "@compiler/$1"),
    ).sort();
  });
  assert.deepEqual(lists[0], lists[1], `${config} file coverage`);
  const paths = lists[0] ?? [];
  return {
    total: paths.length,
    firstParty: paths.filter((path) => !path.startsWith("/") && !path.startsWith("node_modules/") && !path.startsWith("@compiler/")).length,
    external: paths.filter((path) => path.startsWith("/") || path.startsWith("node_modules/")).length,
    compilerLibraries: paths.filter((path) => path.startsWith("@compiler/")).length,
    paths,
  };
}

const originals = new Map<string, Buffer>();
function replace(path: string, text: string) {
  assert.ok(!originals.has(path), `Already probing ${path}`);
  const original = readFileSync(path);
  originals.set(path, original);
  writeFileSync(path, Buffer.concat([original, Buffer.from(`\n${text}\n`)]));
}

function restore() {
  for (const [path, original] of originals) {
    writeFileSync(path, original);
    assert.deepEqual(readFileSync(path), original, `${path} restored`);
  }
  originals.clear();
}

const controls: { name: string; result: ReturnType<typeof pair> }[] = [];
function control(name: string, config: string, codes: number[], baseline: ReturnType<typeof pair>) {
  const result = pair(config);
  controls.push({ name, result });
  const additions = compilers.map((compiler) => {
    const before = baseline[compiler].diagnostics;
    const after = result[compiler].diagnostics;
    assert.ok(before.every((item) => after.includes(item)), `${name} preserves baseline`);
    const added = after.filter((item) => !before.includes(item));
    assert.equal(added.length, codes.length, `${name} diagnostic count`);
    assert.deepEqual(added.map((item) => Number(item.match(/error TS(\d+):/)?.[1])).sort(), [...codes].sort(), name);
    assert.equal(result[compiler].exit === 0, before.length + codes.length === 0);
    return added;
  });
  assert.deepEqual(additions[0], additions[1], `${name} added diagnostics`);
}

const probe = "src/__tsrs_pilot__.tsx";
const toolsProbe = "tools/__tsrs_pilot__.ts";
// Exclusive creates refuse to overwrite existing files.
writeFileSync(probe, "", { flag: "wx" });
let toolsProbeCreated = false;
try {
  writeFileSync(toolsProbe, "", { flag: "wx" });
  toolsProbeCreated = true;
  // Remove probes before collecting real file coverage and baseline timings.
  rmSync(probe);
  rmSync(toolsProbe);
  const main = pair("tsconfig.json");
  assert.deepEqual(main.tsc, { exit: 0, diagnostics: [] });
  assert.deepEqual(main.tsc, main.tsrs);
  const tools = pair("tsconfig.tools.json");
  // Tools are not a required gate. Record diagnostic differences on existing source
  // without suppressing their text or preventing the main-config investigation.
  const toolsOnly = {
    tsc: tools.tsc.diagnostics.filter((item) => !tools.tsrs.diagnostics.includes(item)),
    tsrs: tools.tsrs.diagnostics.filter((item) => !tools.tsc.diagnostics.includes(item)),
  };
  const files = { main: coverage("tsconfig.json"), tools: coverage("tsconfig.tools.json") };

  const samples: Record<Compiler, { seconds: number; peakRssKiB: number }[]> = { tsc: [], tsrs: [] };
  for (let round = 0; round < 8; round++) {
    for (const compiler of round % 2 ? [...compilers].reverse() : compilers) {
      const stats = join(scratch, "time.txt");
      const result = spawnSync("/usr/bin/time", ["-f", "%e %M", "-o", stats,
        `node_modules/.bin/${compiler}`, ...args, "tsconfig.json"], { encoding: "utf8" });
      if (result.error) throw result.error;
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      const [seconds = NaN, peakRssKiB = NaN] = readFileSync(stats, "utf8").trim().split(/\s+/).map(Number);
      assert.ok(Number.isFinite(seconds) && Number.isFinite(peakRssKiB));
      samples[compiler].push({ seconds, peakRssKiB });
    }
  }

  const restoredHashes: Record<string, string> = {};
  const gateFailures: { command: string; exit: number; output: string }[] = [];
  for (const path of ["src/domain.ts", "src/main.tsx", "src/server.ts", "tests/api.test.ts", "vite.config.ts", "tools/mcp-preview.ts"]) {
    try {
      replace(path, 'const __tsrsPilotNumber: number = "intentional error";');
      control(path, "tsconfig.json", [2322], main);
      if (path === "src/domain.ts") {
        // Exercise the public script, the exact CI command, and the aggregate
        // local gate. No deployment workflow or cloud operation is invoked.
        for (const [command, commandArgs] of [
          ["npm", ["run", "check"]],
          ["npx", ["task", "typecheck"]],
          ["npx", ["task", "check"]],
        ] as const) {
          const result = spawnSync(command, [...commandArgs], { encoding: "utf8" });
          if (result.error) throw result.error;
          assert.equal(result.signal, null);
          assert.ok(result.status !== null && result.status !== 0, `${command} rejects the error`);
          const output = normalize(result.stdout + result.stderr);
          assert.match(output, /tsrs --noEmit --project tsconfig.json/);
          assert.match(output, /src\/domain\.ts\(\d+,\d+\): error TS2322:/);
          assert.doesNotMatch(output, /\[(?:lint|format:check|test)\]/);
          gateFailures.push({ command: [command, ...commandArgs].join(" "), exit: result.status, output });
        }
      }
    } finally {
      restore();
    }
    restoredHashes[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  const positive = `import { RecipeId } from "./domain.ts";
import { Schema } from "effect";
const id: RecipeId = Schema.decodeUnknownSync(RecipeId)("pilot");
const button = <button disabled={false}>{id}</button>;
const request: Request = new Request("https://example.invalid");
declare const ctx: ExecutionContext;
ctx.waitUntil(Promise.resolve(request));
export {};\n`;
  writeFileSync(probe, positive, { flag: "wx" });
  control("Bundler .ts import, Effect brand, React JSX, DOM and Workers positive", "tsconfig.json", [], main);
  writeFileSync(probe, `${positive}
const nullString: string = null;
const invalidId: RecipeId = "unvalidated";
const invalidButton = <button disabled="yes" />;
ctx.waitUntil(123);
import { missing } from "./__tsrs_missing_module__";
`);
  control("strict null, Effect brand, JSX prop, Workers argument, missing module", "tsconfig.json", [2322, 2322, 2322, 2345, 2307], main);
  rmSync(probe);

  writeFileSync(toolsProbe, 'export const invalidTool: number = "intentional error";\n', { flag: "wx" });
  control("tools-only file excluded from main", "tsconfig.json", [], main);
  control("tools-only file included by tools config", "tsconfig.tools.json", [2322], tools);
  rmSync(toolsProbe);
  assert.deepEqual(pair("tsconfig.json"), main, "main restored");
  assert.deepEqual(pair("tsconfig.tools.json"), tools, "tools restored");
  const report = {
    node: process.version,
    versions: Object.fromEntries(compilers.map((compiler) => [compiler,
      spawnSync(`node_modules/.bin/${compiler}`, ["--version"], { encoding: "utf8" }).stdout.trim()])),
    baseline: { main, tools, toolsOnly }, files, samples, controls, gateFailures, restoredHashes,
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, mainFiles: files.main.total, toolsFiles: files.tools.total,
    toolsDiagnostics: tools.tsc.diagnostics.length, toolsDifferent: toolsOnly.tsc.length,
    controls: controls.length, gateFailures, samples }, null, 2));
} finally {
  restore();
  rmSync(probe, { force: true });
  if (toolsProbeCreated) rmSync(toolsProbe, { force: true });
  // Keep a default report, but discard transient timing files.
  rmSync(join(scratch, "time.txt"), { force: true });
  if (process.argv[2]) rmSync(scratch, { recursive: true, force: true });
}
