import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { productionApi } from "../production-data.ts";

// Only fixed names are managed. Values never enter output, arguments, Git, or browser assets.
const names = ["FEEDBACK_WEBHOOK_URL", "FEEDBACK_SIGNING_KEY"] as const;
const mode = process.argv[2];
assert(["provision", "status", "smoke"].includes(mode ?? ""), "Use provision, status, or smoke.");
const api = productionApi();
let stage = "discover";

try {
  if (mode === "smoke") {
    // A disposable, header-gated Worker with fake secrets; no household/D1/Access resources.
    const worker = `hearth-feedback-secret-smoke-${randomUUID().slice(0, 8)}`;
    const key = randomUUID();
    const gate = randomUUID();
    const values = ["https://intake.invalid/disposable", key];
    const smokeNames = [...names, "SMOKE_GATE"];
    const subdomain = Schema.decodeUnknownSync(Schema.Struct({ subdomain: Schema.String }))(
      await api.request<unknown>("/workers/subdomain"),
    );
    console.log(`Disposable secret-preservation Worker: ${worker}`);
    try {
      for (const version of [1, 2]) {
        stage = `smoke-upload-${version}`;
        const code = `export default { fetch(request, env) {
          if (request.headers.get('X-Smoke-Gate') !== env.SMOKE_GATE) return new Response(null, {status: 404});
          return Response.json({version: ${version}, webhook: env.FEEDBACK_WEBHOOK_URL === ${JSON.stringify(values[0])}, key: env.FEEDBACK_SIGNING_KEY === ${JSON.stringify(key)}});
        } };`;
        const form = new FormData();
        form.set("metadata", JSON.stringify({ main_module: "index.mjs", compatibility_date: "2026-09-08",
          bindings: version === 1 ? [] : smokeNames.map(name => ({ type: "inherit", name })),
        }));
        form.set("index.mjs", new Blob([code], { type: "application/javascript+module" }), "index.mjs");
        const uploaded = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker}`, {
          method: "PUT", headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, body: form, signal: AbortSignal.timeout(60000),
        });
        assert(uploaded.ok && Schema.decodeUnknownSync(Schema.Struct({ success: Schema.Boolean }))(await uploaded.json()).success, "Disposable Worker upload failed.");
        if (version === 1) {
          stage = "smoke-provision";
          for (const [index, name] of smokeNames.entries()) await api.request(`/workers/scripts/${worker}/secrets`, "PUT", { name, type: "secret_text", text: index === 2 ? gate : values[index] });
          await api.request(`/workers/scripts/${worker}/subdomain`, "POST", { enabled: true });
        }
        stage = `smoke-check-${version}`;
        let verified = false;
        for (let attempt = 0; attempt < 20 && !verified; attempt++) {
          const response = await fetch(`https://${worker}.${subdomain.subdomain}.workers.dev`, { headers: { "X-Smoke-Gate": gate }, signal: AbortSignal.timeout(10000) });
          if (response.ok) {
            const result = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.Number, webhook: Schema.Boolean, key: Schema.Boolean }))(await response.json());
            verified = result.version === version && result.webhook === true && result.key === true;
          }
          if (!verified) await new Promise(resolve => setTimeout(resolve, 1000));
        }
        assert(verified, "Cloudflare secret values did not survive code upload.");
        console.log(`PASS disposable Cloudflare Worker version ${version}: both secret values verified without disclosure.`);
      }
    } finally {
      const previousStage = stage;
      stage = "smoke-cleanup";
      try { await api.request(`/workers/scripts/${worker}`, "DELETE"); }
      catch (error) { if (!(error instanceof Error && error.message.includes("HTTP 404"))) throw error; }
      assert(!(await api.list<{ id: string }>("/workers/scripts")).some(item => item.id === worker), "Disposable Worker cleanup incomplete.");
      console.log("PASS disposable secret-preservation Worker removed.");
      stage = previousStage;
    }
  } else {
    const workers = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String, tags: Schema.optional(Schema.Array(Schema.String)) })))(await api.list<unknown>("/workers/scripts")).filter(worker =>
      ["alchemy:stack:hearth", "alchemy:stage:production", "alchemy:id:Website"].every(tag => worker.tags?.includes(tag)),
    );
    assert.equal(workers.length, 1, "Production Hearth Website must be unambiguous.");
    const worker = workers[0].id;
    if (mode === "provision") {
      stage = "private-source-validation";
      const url = (await readFile(".amp/feedback-state/webhook-url", "utf8")).trim();
      const owner = Schema.decodeUnknownSync(Schema.Struct({ signingKey: Schema.String.check(Schema.isMinLength(32)) }))(JSON.parse(await readFile(".amp/feedback-state/owner.json", "utf8")));
      assert.equal(new URL(url).protocol, "https:", "Intake URL must be HTTPS.");
      stage = "production-provision";
      for (const [index, name] of names.entries()) await api.request(`/workers/scripts/${worker}/secrets`, "PUT", { name, type: "secret_text", text: index === 0 ? url : owner.signingKey });
    }
    stage = "production-status";
    const secrets = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String })))(await api.request<unknown>(`/workers/scripts/${worker}/secrets`));
    for (const name of names) {
      assert(secrets.some(secret => secret.name === name && secret.type === "secret_text"), "Required Cloudflare secret binding missing.");
      console.log(`PRESENT ${name}: Cloudflare-managed secret_text (value not retrieved).`);
    }
    console.log("Production secret presence verified; this is not a household delivery acknowledgement.");
  }
} catch (error) {
  // Cloudflare responses can reflect submitted values: expose fixed stage/status only.
  const status = error instanceof Error ? error.message.match(/HTTP \d{3}/)?.[0] : undefined;
  console.error(`Feedback secrets failed at ${stage}${status ? ` (${status})` : ""}; private details suppressed.`);
  process.exitCode = 1;
}
