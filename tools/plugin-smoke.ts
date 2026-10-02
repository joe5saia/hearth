import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const url = process.argv[2] ?? "http://localhost:5173";
assert(["localhost", "127.0.0.1"].includes(new URL(url).hostname), "Use local development only");
const session = `plugin-${process.pid}`;
const browser = (...args: string[]) => execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", timeout: 90_000 }).trim();
const check = (expression: string, message: string) => {
  browser("eval", `(() => { if (!(${expression})) throw new Error(${JSON.stringify(message)}); return true; })()`);
  console.log(`PASS ${message}`);
};
const settle = () => browser("eval", "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
const screenshot = (name: string) => {
  settle();
  browser("screenshot", resolve(`.amp/in/artifacts/${name}.png`));
};

try {
  await mkdir(".amp/in/artifacts", { recursive: true });
  browser("open", url);
  browser("wait", '[aria-label="Use Hearth in ChatGPT"]');
  for (const [width, height] of [[1280, 1000], [820, 900], [390, 844], [320, 740]]) {
    browser("set", "viewport", String(width), String(height), "2");
    settle();
    check("document.documentElement.scrollWidth <= innerWidth", `header fits at ${width}px`);
    check("(() => { const r = document.querySelector('.chatgpt-open').getBoundingClientRect(); return r.width >= 44 && r.height >= 44 && r.right <= innerWidth; })()", `ChatGPT entry has a visible 44px target at ${width}px`);
    browser("click", '[aria-label="Use Hearth in ChatGPT"]');
    browser("wait", 'dialog[open] .chatgpt-setup');
    check("document.querySelector('dialog').getAttribute('aria-label') === 'Use Hearth in ChatGPT'", "dialog has an accessible name");
    check("document.querySelector('dialog').scrollWidth <= document.querySelector('dialog').clientWidth", `installation guide fits at ${width}px`);
    check("document.querySelector('.chatgpt-actions .primary').href === 'https://github.com/joe5saia/hearth/releases/latest/download/hearth-chatgpt.zip'", "download points to web ZIP, not desktop or source archive");
    check("!!document.querySelector('a[href=\"https://chatgpt.com/plugins/plugin_asdk_app_6abc4d71239c8191b3718add10501aff\"]')", "connection link uses the registered Hearth app");
    check("document.querySelector('.chatgpt-setup').textContent.includes('Upload plugin') && document.querySelector('.chatgpt-notice').textContent.includes('does not grant access')", "manual installation and permissions explained");
    if (width === 1280) screenshot("hearth-chatgpt-install");
    if (width === 390) screenshot("hearth-chatgpt-narrow");
    browser("press", "Escape");
    browser("wait", "--fn", "!document.querySelector('dialog[open]')");
    browser("wait", "--fn", "document.activeElement.getAttribute('aria-label') === 'Use Hearth in ChatGPT'");
    check("document.activeElement.getAttribute('aria-label') === 'Use Hearth in ChatGPT'", "Escape closes and restores focus");
  }
  browser("set", "viewport", "390", "844", "2");
  browser("click", '[aria-label="Use Hearth in ChatGPT"]');
  for (const index of [1, 2]) {
    const selector = `.chatgpt-setup details:nth-of-type(${index}) summary`;
    browser("eval", `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    settle();
    browser("click", selector);
    check(`document.querySelectorAll('.chatgpt-setup details')[${index - 1}].open`, `disclosure ${index} expands`);
  }
  browser("eval", "document.querySelector('.chatgpt-setup details').scrollIntoView({block:'start'})");
  check("document.querySelector('dialog').scrollWidth <= document.querySelector('dialog').clientWidth", "expanded setup and endpoint fit narrow layout");
  screenshot("hearth-chatgpt-update");
  browser("press", "Escape");
  browser("click", '[aria-label="Use Hearth in ChatGPT"]');
  browser("click", '[aria-label="Close dialog"]');
  check("!document.querySelector('dialog[open]')", "close button dismisses dialog");
  console.log("Plugin browser smoke passed. External release downloads and ChatGPT installation require a published web archive and account access; not exercised.");
} finally {
  browser("close");
}
