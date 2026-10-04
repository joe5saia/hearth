import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = new URL(process.argv[2] ?? "http://localhost:5173").origin;
assert(["localhost", "127.0.0.1"].includes(new URL(root).hostname), "Use disposable local data only");
const demo = resolve("tools/ui-demo.ts");
const scratch = await mkdtemp(join(tmpdir(), "hearth-demo-failures-"));
const household = async () => {
  const response = await fetch(`${root}/api/household`);
  assert(response.ok);
  return response.json();
};
const original = await household();
const failures: string[] = [];

try {
  for (const fault of ["route", "extra", "teardown"]) {
    const run = await mkdtemp(join(scratch, `${fault}-`));
    const hook = join(run, "inject.mjs");
    // Exercise the actual demo, browser, Worker and D1; only inject transport/teardown failures.
    await writeFile(
      hook,
      `
      import { chromium } from '/tmp/hearth-ui/node_modules/playwright/index.mjs';
      const launch = chromium.launch.bind(chromium);
      chromium.launch = async (...args) => {
        const browser = await launch(...args);
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async (...args) => {
          const context = await newContext(...args);
          if (${JSON.stringify(fault)} === 'teardown') {
            const close = context.close.bind(context);
            context.close = async () => {
              await close(); await browser.close();
              console.log('INJECTED teardown');
              throw new Error('Injected recording teardown failure');
            };
          }
          const newPage = context.newPage.bind(context);
          context.newPage = async (...args) => {
            const page = await newPage(...args);
            page.on('request', request => {
              const kind = new URL(request.url()).pathname.split('/')[2];
              if (!['PUT', 'POST'].includes(request.method()) || !['extras', 'meals', 'recipes', 'groceries', 'collections'].includes(kind)) return;
              const body = request.postDataJSON();
              if (body?.id) console.log('OWNED ' + JSON.stringify({ kind, id: body.id }));
            });
            if (${JSON.stringify(fault)} === 'teardown') {
              page.on('response', response => {
                if (response.url().endsWith('/api/groceries') && response.request().method() === 'PUT' && response.ok()) {
                  console.log('INJECTED interrupted browser after persisted grocery');
                  setTimeout(() => page.close().catch(() => {}), 100);
                }
              });
            } else {
              await page.route('**/api/**', async route => {
                const request = route.request();
                const body = request.method() === 'PUT' ? request.postDataJSON() : null;
                const reject = ${JSON.stringify(fault)} === 'route'
                  ? request.url().endsWith('/api/shopping-order') && request.method() === 'PUT'
                  : request.url().endsWith('/api/extras') && body?.checked === 1 && body.name.includes('demo');
                if (reject) {
                  console.log('INJECTED ${fault}');
                  await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected save failure' }) });
                } else await route.continue();
              });
            }
            return page;
          };
          return context;
        };
        return browser;
      };
    `,
    );
    let output = "";
    const child = spawn(process.execPath, ["--import", hook, demo, root], {
      cwd: run,
      env: { ...process.env, TMPDIR: run },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output += chunk.toString();
        process.stdout.write(chunk);
      });
    const exit = await new Promise<number | null>((done, reject) => {
      child.on("error", reject);
      child.on("close", done);
    });
    const owned = output
      .split("\n")
      .filter((line) => line.startsWith("OWNED "))
      .map((line) => JSON.parse(line.slice(6)));
    const current = await household();
    try {
      assert(output.includes(`INJECTED ${fault}`), `${fault} injection was not exercised`);
      assert.notEqual(exit, 0, `Demo falsely succeeded after ${fault} failure`);
      assert(
        output.includes(
          fault === "teardown"
            ? "Injected recording teardown failure"
            : "Expected household change did not persist",
        ),
        "Demo must fail for the injected fault, not an unrelated error",
      );
      assert.deepEqual(current, original, "Demo failed to restore its exact original household");
      assert(
        !(await readdir(run)).some((name) => name.startsWith("hearth-demo-")),
        "Recording scratch directory leaked",
      );
      console.log(`PASS ${fault}: demo rejected failure and restored household/scratch`);
    } catch (error) {
      const message = `${fault}: ${error instanceof Error ? error.message : String(error)}`;
      failures.push(message);
      console.error(`FAIL ${message}`);
    } finally {
      // A failing implementation must not leave the reproduction fixtures behind.
      const api = async (path: string, method: string, body?: unknown) => {
        const response = await fetch(`${root}/api/${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        assert(response.ok, `Fallback cleanup ${path}: ${response.status}`);
      };
      for (const kind of ["extras", "meals", "recipes", "groceries", "collections"]) {
        for (const item of current[kind]) {
          if (
            owned.some((entry) => entry.kind === kind && entry.id === item.id) &&
            !original[kind].some((entry: any) => entry.id === item.id)
          ) {
            await api(`${kind}/${encodeURIComponent(item.id)}`, "DELETE");
          }
        }
      }
      if (JSON.stringify(current.shoppingOrder) !== JSON.stringify(original.shoppingOrder))
        await api("shopping-order", "PUT", original.shoppingOrder);
      for (const key of new Set([...current.checks, ...original.checks].map((entry: any) => entry.key))) {
        const checked = original.checks.some((entry: any) => entry.key === key && entry.checked === 1)
          ? 1
          : 0;
        const now = current.checks.some((entry: any) => entry.key === key && entry.checked === 1) ? 1 : 0;
        if (checked !== now) await api("checks", "PUT", { key, checked });
      }
      assert.deepEqual(await household(), original, "Reproduction fallback cleanup failed");
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
assert.deepEqual(failures, [], "Demo failure smoke regressions");
