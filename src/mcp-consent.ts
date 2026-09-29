import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function consentPage(details: ConsentDescription, handle: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Hearth</title>
<style>
  :root { color-scheme: light; font-family: "DM Sans Variable", system-ui, sans-serif; color: #343c30; background: #faf9f5; font-synthesis: none; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 48px 20px; line-height: 1.5; }
  main { width: 100%; max-width: 520px; margin: 0 auto; }
  .brand { display: flex; align-items: center; justify-content: center; gap: 9px; font: 37px "Lora Variable", Georgia, serif; letter-spacing: -1.8px; }
  .brand svg { color: #5c6b4d; }
  .brand-dot { color: #b78b6b; }
  .caption { text-align: center; color: #5f6956; font-size: 12px; letter-spacing: 1.1px; margin: 8px 0 32px; }
  .card { background: #fffefa; border: 1px solid #e5e5db; border-radius: 12px; overflow: hidden; }
  .intro { padding: 32px; background: #f0f0e7; border-bottom: 1px solid #e5e5db; }
  .eyebrow { font-size: 12px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; color: #5f6956; margin: 0 0 12px; }
  h1 { font: 500 30px/1.25 "Lora Variable", Georgia, serif; margin: 0 0 14px; }
  p { margin: 0; }
  strong, .destination { overflow-wrap: anywhere; }
  form { padding: 28px 32px 32px; }
  fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
  legend { font-size: 14px; font-weight: 600; padding: 0; margin-bottom: 14px; }
  .permission { display: flex; align-items: flex-start; gap: 12px; padding: 16px; border: 1px solid #e5e5db; border-radius: 8px; margin-bottom: 12px; cursor: pointer; }
  .permission:has(input:checked) { background: #f3f4ec; border-color: #c8cebc; }
  input[type=checkbox] { accent-color: #4e6045; width: 20px; height: 20px; flex-shrink: 0; margin: 2px 0 0; }
  .permission strong { display: block; font-size: 16px; font-weight: 600; }
  .permission small { display: block; color: #5f6956; font-size: 14px; margin-top: 4px; }
  .destination { color: #5f6956; font-size: 14px; margin: 20px 0 24px; }
  .destination strong { color: #343c30; font-weight: 500; }
  .identity { margin-top: 16px; font-size: 14px; }
  .warning { padding: 12px 14px; border-left: 3px solid #a27455; background: #f6eee3; font-size: 14px; margin-bottom: 24px; }
  .actions { display: flex; gap: 12px; }
  button { flex: 1; min-height: 48px; border: 1px solid #daddce; border-radius: 6px; padding: 12px 16px; font: inherit; font-weight: 500; cursor: pointer; background: #fcfbf8; color: #5e6850; }
  button:hover { background: #eef0e5; }
  .primary { background: #4e6045; border-color: #4e6045; color: #fffef5; }
  .primary:hover { background: #3e5036; }
  button:focus-visible, input:focus-visible { outline: 2px solid #a27455; outline-offset: 4px; }
  footer { color: #5f6956; text-align: center; font-size: 13px; margin-top: 20px; }
  @media (max-width: 480px) { body { padding: 28px 16px; } .intro { padding: 24px; } form { padding: 24px; } h1 { font-size: 27px; } .actions { flex-direction: column; } }
</style>
</head>
<body><main>
  <div class="brand"><svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9 21v-9h6v9"/></svg><span>hearth<span class="brand-dot">.</span></span></div>
  <p class="caption">Our everyday table</p>
  <section class="card" aria-labelledby="consent-title">
    <div class="intro"><p class="eyebrow">App connection</p><h1 id="consent-title">Connect to Hearth</h1><p>Allow <strong>${escape(details.clientName)}</strong> to access your household recipes?</p>
      <p class="identity">${details.clientDomain ? `Client domain: <strong>${escape(details.clientDomain)}</strong>` : "This app’s name is unverified. It was supplied by the app, not verified by Hearth."}</p>
    </div>
    <form method="post" action="/authorize">
      <input type="hidden" name="handle" value="${escape(handle)}">
      <fieldset><legend>Choose what this app can do</legend>
        ${details.scope
          .map((scope) => {
            const title =
              scope === "recipes:read"
                ? "Read and search recipes"
                : scope === "recipes:write"
                  ? "Create and edit recipes"
                  : scope;

            const description =
              scope === "recipes:read"
                ? "View recipes, ingredients and cooking instructions."
                : scope === "recipes:write"
                  ? "Add new recipes and make changes to existing ones."
                  : "Allow this requested permission.";

            return `<label class="permission"><input type="checkbox" name="scope" value="${escape(scope)}" checked><span><strong>${escape(title)}</strong><small>${description}</small></span></label>`;
          })
          .join("")}
      </fieldset>
      <p class="destination">After connecting, you’ll return to<br><strong>${escape(details.redirectHost)}</strong>${details.redirectIsLoopback ? " (on this computer)" : ""}.</p>
      ${details.redirectIsLoopback ? '<p class="warning">Continue only if you just started connecting from this local app. Any process on your computer could be listening, regardless of the app name shown above.</p>' : ""}
      <div class="actions"><button class="primary" name="decision" value="approve">Allow access</button><button name="decision" value="deny">Deny</button></div>
    </form>
  </section>
  <footer>Only connect apps you know and trust.</footer>
</main></body></html>`;
}
