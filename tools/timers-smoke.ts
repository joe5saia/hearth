import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

// Real browser/app/localStorage/Web Audio; no mocked API or accelerated clock.
const url = process.argv[2] ?? "http://localhost:5173";
const target = new URL(url);
if (!["localhost", "127.0.0.1"].includes(target.hostname)) {
  throw new Error("Run this smoke test against local development, not production.");
}
const session = `timers-${process.pid}`;
const recipe = {
  id: `timer-defaults-${crypto.randomUUID()}`,
  title: "Timer smoke recipe abcdefghijklmnop",
  description: "Disposable browser smoke fixture",
  servings: 2,
  minutes: 30,
  category: "",
  photo: "",
  source: "",
  rating: "neutral",
  ingredients: [{ name: "Water", quantity: 1, unit: "cup" }],
  instructions: ["Wait for the timer."],
};
let recipeCreated = false;
const browser = (...args: string[]) =>
  execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 90_000,
    env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: "30000" },
  }).trim();
const check = (expression: string, message: string) => {
  browser("eval", `(() => { if (!(${expression})) throw new Error(${JSON.stringify(message)}); return true; })()`);
  console.log(`PASS ${message}`);
};
const start = (name: string, hours: string, minutes: string) => {
  if (browser("eval", "document.querySelector('.timer-create').open") === "false") {
    browser("click", ".timer-create > summary");
  }
  browser("fill", '[name="timerName"]', name);
  browser("fill", '[name="timerHours"]', hours);
  browser("fill", '[name="timerMinutes"]', minutes);
  browser("click", '.timer-form button[type="submit"]');
};
const layout = (width: number, height: number) => {
  browser("set", "viewport", String(width), String(height), "2");
  browser("eval", "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  check(`document.documentElement.scrollWidth <= innerWidth &&
    document.querySelector('.timer-toggle').getBoundingClientRect().left >= 0 &&
    document.querySelector('.timer-toggle').getBoundingClientRect().right <= innerWidth &&
    Array.from(document.querySelectorAll('.timer-header-actions button')).every(button => {
      const bounds = button.getBoundingClientRect();
      return bounds.width >= 44 && bounds.height >= 44 && bounds.left >= 0 && bounds.right <= innerWidth;
    }) &&
    document.querySelector('.timer-panel').getBoundingClientRect().left === 0 &&
    document.querySelector('.timer-panel').getBoundingClientRect().right <= innerWidth`, `${width}×${height}: drawer/header fit without horizontal overflow`);
};

try {
  browser("open", url);
  browser("wait", ".timer-toggle");
  browser("click", ".timer-toggle");
  browser("wait", '[name="timerName"]');
  browser("wait", "--fn", "getComputedStyle(document.querySelector('.timer-panel')).transform === 'matrix(1, 0, 0, 1, 0, 0)'");
  check("document.querySelector('.timer-empty') && document.activeElement.ariaLabel === 'Collapse timers'", "empty panel and opening focus");
  check("document.querySelector('[name=timerName]').value === 'Timer I'", "first generic default is Timer I");
  check("!document.querySelector('.timer-header-actions')", "empty header has no timer-specific actions");

  start("Invalid", "0", "0");
  check("!document.querySelector('.timer-card') && document.querySelector('.timer-error').textContent.includes('at least one minute')", "zero duration rejected");
  start("Invalid", "0", "60");
  check("!document.querySelector('.timer-card') && !document.querySelector('[name=timerMinutes]').validity.valid", "minutes above 59 rejected");
  start("Invalid", "1.5", "0");
  check("!document.querySelector('.timer-card') && !document.querySelector('[name=timerHours]').validity.valid", "fractional hours rejected");
  start("  Slow braise  ", "1", "7");
  start("Quick pasta", "0", "1");
  check(`(() => {
    const timers = JSON.parse(localStorage.getItem('hearth-kitchen-timers-v1'));
    return timers.length === 2 && timers[0].name === 'Slow braise' &&
      timers[0].endsAt - timers[0].startedAt === 4020000 &&
      timers[1].endsAt - timers[1].startedAt === 60000 &&
      document.querySelector('.timer-toggle-label > span').textContent === 'Quick pasta' &&
      document.querySelector('.timer-card').ariaLabel === 'Quick pasta' &&
      /01:0[67]:[0-9]{2}/.test(document.querySelector('[aria-label="Slow braise"] .timer-countdown').textContent);
  })()`, "named hour/minute timers, trimming, HH:MM:SS and earliest-first order");
  check(`Array.from(document.querySelectorAll('.timer-card')).every(card => {
    const times = card.querySelectorAll('time');
    const duration = Date.parse(times[1].dateTime) - Date.parse(times[0].dateTime);
    return times.length === 2 && times[0].textContent && times[1].textContent &&
      duration === (card.ariaLabel === 'Quick pasta' ? 60000 : 4020000);
  })`, "start/end timestamps independently match requested durations");

  layout(1180, 820);
  layout(1024, 768);
  check("Array.from(document.querySelectorAll('.timer-card')).every(el => el.getBoundingClientRect().bottom <= innerHeight)", "both timers fit landscape iPad with creation form collapsed");
  layout(390, 844);
  browser("click", ".timer-create > summary");
  check("Array.from(document.querySelectorAll('.timer-panel input, .timer-panel button')).every(el => el.getBoundingClientRect().height >= 44)", "44px timer touch targets");
  browser("click", ".timer-create > summary");
  browser("press", "Escape");
  check("document.querySelector('.timer-panel').inert && document.activeElement.classList.contains('timer-toggle')", "Escape collapses inert drawer and restores focus");
  browser("click", 'nav a[href="#recipes"]');
  check("document.querySelector('.timer-toggle-label > span').textContent === 'Quick pasta'", "timer stays in header across pages");
  browser("click", ".topbar > .secondary");
  browser("wait", "dialog[open] .timer-toggle");
  check("document.querySelectorAll('.timer-toggle').length === 1 && document.querySelector('dialog[open] .timer-toggle').textContent.includes('Quick pasta')", "single live timer controller moves into dialog header");
  browser("click", ".timer-toggle");
  browser("wait", ".timer-create > summary");
  browser("press", "Escape");
  check("document.querySelector('dialog[open]') && document.querySelector('.timer-panel').inert", "Escape collapses timers without closing the recipe dialog");
  browser("click", '[aria-label="Close dialog"]');
  check("document.querySelector('.topbar .timer-toggle').textContent.includes('Quick pasta')", "timer returns to app header after closing dialog");
  browser("reload");
  browser("wait", ".timer-toggle");
  check("document.querySelector('.timer-toggle').textContent.includes('Tap to enable sound') && document.querySelectorAll('.timer-card').length === 2", "reload retains deadlines and prompts to re-enable audio");

  // Observe native oscillators while forwarding every call to the real Web Audio API.
  browser("eval", `(() => {
    window.timerTones = [];
    const original = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function(...args) {
      window.timerTones.push({ frequency: this.frequency.value, state: this.context.state, type: this.type });
      return original.call(this, ...args);
    };
  })()`);
  browser("click", ".timer-toggle");
  browser("wait", ".timer-create > summary");
  browser("click", '[aria-label="Collapse timers"]');
  console.log("Waiting for a real one-minute timer to expire while the drawer is collapsed…");
  await setTimeout(61_000);
  browser("wait", ".timer-toggle.timer-due");
  check("document.querySelector('.timer-toggle strong').textContent === '00:00:00' && document.querySelector('[role=status]').textContent.includes('1 timer finished')", "expiry clamps to zero, flashes header, and announces completion");
  check("window.timerTones.length >= 2 && window.timerTones[0].frequency === 523.25 && window.timerTones[1].frequency === 659.25 && window.timerTones.every(t => t.state === 'running' && t.type === 'sine')", "expiry schedules both gentle tones through running native Web Audio");
  browser("click", ".timer-toggle");
  browser("wait", '[aria-label="Dismiss Quick pasta"]');
  check("getComputedStyle(document.querySelector('.timer-card.timer-due')).animationName === 'timer-pulse'", "finished card pulses");
  browser("set", "media", "light", "reduced-motion");
  check("getComputedStyle(document.querySelector('.timer-card.timer-due')).animationName === 'none'", "reduced motion keeps a static finished highlight");
  browser("reload");
  browser("wait", ".timer-toggle.timer-due");
  browser("click", ".timer-toggle");
  browser("wait", '[aria-label="Dismiss Quick pasta"]');
  check("document.querySelector('[aria-label=\"Quick pasta\"] .timer-countdown').textContent === '00:00:00'", "expired timer remains dismissible after reload");
  browser("eval", "window.extensionClickedAt = Date.now(); window.expiredStartedAt = JSON.parse(localStorage.getItem('hearth-kitchen-timers-v1')).find(t => t.name === 'Quick pasta').startedAt");
  browser("click", '[aria-label="Add 5 minutes to Quick pasta"]');
  browser("wait", "--fn", "!document.querySelector('.timer-due')");
  check(`(() => {
    const timer = JSON.parse(localStorage.getItem('hearth-kitchen-timers-v1')).find(t => t.name === 'Quick pasta');
    return timer.endsAt >= window.extensionClickedAt + 300000 && timer.endsAt <= Date.now() + 300000 &&
      timer.startedAt === window.expiredStartedAt &&
      document.querySelector('[aria-label="Quick pasta"] .timer-card-heading > span').textContent === 'Running';
  })()`, "+5 restarts an overdue timer from now, clears flashing, and preserves its original start");
  browser("click", '[aria-label="Dismiss timer Quick pasta"]');
  check("!document.querySelector('.timer-due') && document.querySelector('.timer-toggle-label > span').textContent === 'Slow braise'", "dismiss removes alarm and promotes next running timer");
  browser("click", '[aria-label="Cancel Slow braise"]');
  check("document.querySelector('.timer-empty') && localStorage.getItem('hearth-kitchen-timers-v1') === '[]'", "cancel removes persisted timer");

  for (const expected of ["Timer I", "Timer II", "Timer III", "Timer IV"]) {
    if (browser("eval", "document.querySelector('.timer-create').open") === "false") {
      browser("click", ".timer-create > summary");
    }
    check(`document.querySelector('[name=timerName]').value === ${JSON.stringify(expected)}`, `${expected} default uses Roman numerals`);
    browser("click", '.timer-form button[type="submit"]');
    browser("wait", `[aria-label="Cancel ${expected}"]`);
  }
  browser("click", '[aria-label="Cancel Timer II"]');
  browser("click", ".timer-create > summary");
  check("document.querySelector('[name=timerName]').value === 'Timer II'", "generic defaults avoid collisions after cancellation");
  for (const name of ["Timer I", "Timer III", "Timer IV"]) browser("click", `[aria-label="Cancel ${name}"]`);

  start("Extension first", "0", "1");
  start("Extension second", "0", "2");
  browser("eval", "window.extensionTimers = JSON.parse(localStorage.getItem('hearth-kitchen-timers-v1'))");
  browser("click", '[aria-label="Collapse timers"]');
  browser("click", '[aria-label="Add 1 minute to Extension first"]');
  check(`(() => {
    const timers = JSON.parse(localStorage.getItem('hearth-kitchen-timers-v1'));
    return timers[0].endsAt === window.extensionTimers[0].endsAt + 60000 &&
      timers[0].startedAt === window.extensionTimers[0].startedAt &&
      timers[1].endsAt === window.extensionTimers[1].endsAt &&
      document.querySelector('.timer-toggle').getAttribute('aria-expanded') === 'false';
  })()`, "header +1 extends only the selected running timer without opening the drawer");
  browser("click", '[aria-label="Add 5 minutes to Extension first"]');
  check(`(() => {
    const timers = JSON.parse(localStorage.getItem('hearth-kitchen-timers-v1'));
    return timers[0].endsAt - timers[0].startedAt === 420000 &&
      timers[1].endsAt === window.extensionTimers[1].endsAt &&
      document.querySelector('.timer-toggle-label > span').textContent === 'Extension second' &&
      Date.parse(document.querySelector('[aria-label="Extension first"]').querySelectorAll('time')[1].dateTime) === window.extensionTimers[0].startedAt + 420000;
  })()`, "header +5 accumulates exactly five minutes and promotes the now-earliest timer");
  browser("reload");
  browser("wait", '[aria-label="Dismiss timer Extension second"]');
  check("JSON.parse(localStorage.getItem('hearth-kitchen-timers-v1'))[0].endsAt - JSON.parse(localStorage.getItem('hearth-kitchen-timers-v1'))[0].startedAt === 420000", "extended deadline survives reload");
  browser("click", '[aria-label="Dismiss timer Extension second"]');
  browser("wait", '[aria-label="Dismiss timer Extension first"]');
  check("document.querySelector('.timer-toggle-label > span').textContent === 'Extension first' && JSON.parse(localStorage.getItem('hearth-kitchen-timers-v1')).length === 1", "header dismiss removes only its timer and promotes the next");
  browser("click", '[aria-label="Dismiss timer Extension first"]');
  check("!document.querySelector('.timer-header-actions') && localStorage.getItem('hearth-kitchen-timers-v1') === '[]' && document.activeElement.classList.contains('timer-toggle')", "dismissing the last timer removes actions, saves removal, and restores focus");

  const saved = await fetch(new URL("/api/recipes", target), {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: target.origin },
    body: JSON.stringify(recipe),
  });
  if (!saved.ok) throw new Error(`Could not create disposable recipe fixture: ${saved.status}`);
  recipeCreated = true;
  browser("reload");
  browser("wait", '[aria-label="Search recipes"]');
  browser("fill", '[aria-label="Search recipes"]', recipe.title);
  browser("wait", ".recipe-row-main");
  browser("click", ".recipe-row-main");
  browser("wait", "dialog.fullscreen[open] .timer-toggle");
  browser("click", ".timer-toggle");
  browser("wait", '[name="timerName"]');
  check("document.querySelector('[name=timerName]').value === 'Timer smoke recipe abcdef' && document.querySelector('[name=timerName]').value.length === 25", "open recipe supplies its name truncated to 25 characters");
  browser("click", '.timer-form button[type="submit"]');
  browser("wait", '[aria-label="Cancel Timer smoke recipe abcdef"]');
  check("document.querySelector('[aria-label=\"Timer smoke recipe abcdef\"]')", "recipe default is saved without typing a name");
  const customName = "Custom timer name longer than twenty-five characters";
  start(customName, "0", "10");
  check(`document.querySelector('[aria-label=${JSON.stringify(customName)}]')`, "25-character cap applies only to defaults, not edited names");
  browser("click", '[aria-label="Collapse timers"]');
  browser("click", '[aria-label="Close dialog"]');
  browser("wait", ".topbar .timer-toggle");
  browser("click", ".timer-toggle");
  browser("wait", ".timer-create > summary");
  browser("click", ".timer-create > summary");
  check("document.querySelector('[name=timerName]').value === 'Timer I'", "closing the recipe restores a generic default");
  browser("click", '[aria-label="Cancel Timer smoke recipe abcdef"]');
  browser("click", `[aria-label="Cancel ${customName}"]`);
  console.log("Timer browser smoke passed (real elapsed time; landscape and narrow Chromium layouts, not physical iPad Safari).");
} finally {
  try {
    if (recipeCreated) {
      const removed = await fetch(new URL(`/api/recipes/${recipe.id}`, target), {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Origin: target.origin },
      });
      if (!removed.ok) throw new Error(`Could not clean up disposable recipe fixture: ${removed.status}`);
    }
  } finally {
    browser("close");
  }
}
