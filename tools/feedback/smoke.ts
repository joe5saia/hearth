import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { FeedbackSchema } from "../../src/feedback-contract.ts";

// Supplied by task ui:setup, not a production dependency.
// @ts-expect-error External UI runtime.
const { chromium, webkit, devices } = await import("/tmp/hearth-ui/node_modules/playwright/index.mjs");
const live = process.argv.includes("--live-intake");
assert(process.argv.slice(2).every(arg => arg === "--live-intake"));
const url = "http://127.0.0.1:8790";
const artifacts = resolve(".amp/in/artifacts");
await mkdir(artifacts, { recursive: true });
await mkdir(".amp/feedback-state", { recursive: true, mode: 0o700 });
const initial = await (await fetch(`${url}/api/household`)).text();
const browsers = [];
let savedTicket;
if (live) {
  try { savedTicket = Schema.decodeUnknownSync(FeedbackSchema)(JSON.parse(await readFile(".amp/feedback-state/validation-ticket.json", "utf8"))); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
}
try {
  for (const [name, engine, profile] of [
    ["desktop", chromium, { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 }],
    ["iphone", webkit, devices["iPhone 14"]],
    ["ipad", webkit, devices["iPad Pro 11"]],
  ] as const) {
    const browser = await engine.launch();
    browsers.push(browser);
    const context = await browser.newContext({ ...profile, deviceScaleFactor: 2 });
    // Approximate installed display mode; this is not a physical-device/installation test.
    if (name !== "desktop") await context.addInitScript(() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query) => query === "(display-mode: standalone)" ? Object.defineProperty(original(query), "matches", { value: true }) : original(query);
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(`${url}/#shopping`);
    await page.getByRole("heading", { name: "Shopping list", exact: true }).waitFor();
    const open = async () => {
      await page.getByLabel("Page options", { exact: true }).click();
      await page.getByRole("button", { name: "File a ticket", exact: true }).click();
      await page.getByRole("dialog", { name: "File a ticket" }).waitFor();
    };
    await open();
    const field = page.getByLabel("Your request", { exact: true });
    assert(await field.evaluate(element => element === document.activeElement), `${name} autofocus`);
    if (name !== "desktop") assert(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), `${name} touch pointer`);
    assert(await page.getByRole("button", { name: "Send ticket", exact: true }).isDisabled());
    await field.fill("Keyboard check, not submitted");
    await field.press("Shift+Enter");
    assert((await field.inputValue()).endsWith("\n"), `${name} Shift+Enter keeps a new line`);
    await field.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    assert.equal(await page.evaluate(() => sessionStorage.getItem("hearth-feedback-attempt")), null, `${name} IME Enter does not submit`);
    if (name !== "desktop") assert.equal(JSON.parse(await page.evaluate(() => sessionStorage.getItem("hearth-feedback-draft"))).context.display, "standalone");
    await field.press("Escape");
    await page.waitForFunction(() => !document.querySelector("dialog"));
    await page.evaluate(ticket => {
      if (ticket) sessionStorage.setItem("hearth-feedback-draft", JSON.stringify(ticket));
      else sessionStorage.removeItem("hearth-feedback-draft");
    }, savedTicket);
    await open();
    if (!savedTicket) {
      assert(await page.getByRole("button", { name: "Send ticket", exact: true }).isDisabled());
      await field.fill("Isolated intake validation: improve the empty shopping-list explanation to say how to add groceries using List Builder. Build a local review demo only, with disposable sample data.");
      await field.press("Shift+Enter");
      await field.press("End");
      await field.type("Keep the existing Hearth design.");
      assert((await field.inputValue()).includes("\n"), "Shift+Enter adds a line without submitting");
    }
    await page.screenshot({ path: `${artifacts}/feedback-${name}.png` });
    const draft = Schema.decodeUnknownSync(FeedbackSchema)(JSON.parse(await page.evaluate(() => sessionStorage.getItem("hearth-feedback-draft"))));
    {
      assert.equal(draft.context.page, "shopping");
      assert.equal(draft.context.location, "/#shopping");
      // Real HTTP-boundary failure: no mocked component/dependency, no external event yet.
      let releaseFault: () => void = () => {};
      const gate = new Promise<void>(resolve => { releaseFault = resolve; });
      await page.route("**/api/feedback", async route => {
        await gate;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary validation outage. Retry safely with this draft." }) });
      });
      await field.press("Enter");
      await page.getByRole("button", { name: "Sending…" }).waitFor();
      assert(await page.getByRole("button", { name: "Sending…" }).isDisabled());
      await page.screenshot({ path: `${artifacts}/feedback-${name}-sending.png` });
      releaseFault();
      await page.getByRole("alert").filter({ hasText: "Temporary validation outage" }).waitFor();
      assert.equal(await field.inputValue(), draft.request);
      const newTicket = page.getByRole("button", { name: "Start a new ticket" });
      await newTicket.scrollIntoViewIfNeeded();
      const actionBounds = await newTicket.boundingBox();
      const dialogBounds = await page.getByRole("dialog").boundingBox();
      assert(actionBounds.height >= 44);
      assert(actionBounds.y >= dialogBounds.y && actionBounds.y + actionBounds.height <= dialogBounds.y + dialogBounds.height, "New-ticket action is reachable inside the scrollable dialog");
      await page.screenshot({ path: `${artifacts}/feedback-${name}-error.png` });
      await page.reload();
      await open();
      assert.equal(await field.inputValue(), draft.request);
      assert(await field.getAttribute("readonly") !== null, "Attempt identity survives reload");
      assert.deepEqual(JSON.parse(await page.evaluate(() => sessionStorage.getItem("hearth-feedback-draft"))), draft);
      await page.unroute("**/api/feedback");
    }
    if (live) {
      await field.press("Enter");
      await page.getByRole("heading", { name: "On its way to Amp" }).waitFor();
      await page.screenshot({ path: `${artifacts}/feedback-${name}-success.png` });
      assert.equal(await page.evaluate(() => sessionStorage.getItem("hearth-feedback-draft")), null);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      assert(await page.getByLabel("Page options", { exact: true }).evaluate(element => element === document.activeElement), "Focus returns to entry point");
      savedTicket = draft;
      await writeFile(".amp/feedback-state/validation-ticket.json", JSON.stringify(savedTicket), { mode: 0o600 });
    } else {
      await field.press("Enter");
      await page.getByRole("alert").filter({ hasText: "isn’t connected" }).waitFor();
      await page.getByLabel("Close dialog").click();
    }
    assert.deepEqual(errors, [], `${name} browser errors`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} no page overflow`);
    console.log(`PASS ${name}: labelled dialog, focus, Enter/Shift+Enter, preserved context and draft, ${live ? "real Worker/Amp acknowledgement" : "honest disconnected state"}${name === "desktop" ? "" : ", coarse pointer and standalone display emulation"}`);
    await context.close();
  }
  assert.equal(await (await fetch(`${url}/api/household`)).text(), initial, "No household mutations");
  if (live) {
    const privateConfig = JSON.parse(await readFile(".amp/feedback-state/owner.json", "utf8"));
    for (const name of await readdir("dist/assets")) if (name.endsWith(".js")) {
      const asset = await readFile(`dist/assets/${name}`, "utf8");
      assert(!asset.includes(privateConfig.signingKey) && !asset.includes((await readFile(".amp/feedback-state/webhook-url", "utf8")).trim()), "No credentials in browser assets");
    }
  }
  console.log("PASS household unchanged; review screenshots in .amp/in/artifacts; live runs reuse one ticket across devices");
} finally {
  for (const browser of browsers) await browser.close();
}
