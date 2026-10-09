import server from "../../src/server";
import { recipeMcp } from "../../src/mcp";
import type { WebsiteEnv } from "../../alchemy.run";

// Integration-only upstream transport: the actual Worker/D1 pipeline consumes recorded wire formats.
// Real model accuracy is exercised separately by matching:eval against Cloudflare.
export default {
  async fetch(request: Request, env: WebsiteEnv, ctx: ExecutionContext) {
    // Bulk-matching fixtures opt out of automatic work while seeding their inputs.
    const background = request.headers.has("X-Test-Background") ? ctx : undefined;
    // Keep the outer workerd request alive while cancelling only the request passed
    // to the real HTTP/MCP handler, so runtime teardown cannot mask missing wiring.
    const controller = request.headers.has("X-Test-Cancel") ? new AbortController() : undefined;
    const incoming = controller ? new Request(request, { signal: controller.signal }) : request;

    const run = async (
      model: string,
      input: Parameters<Ai["run"]>[1],
      options?: Parameters<Ai["run"]>[2],
    ) => {
      if (controller) {
        options?.signal?.addEventListener("abort", () => console.info("test_model_aborted"), { once: true });
        setTimeout(() => {
          controller.abort();
          console.info("test_request_aborted");
        }, 30);
      }

      const pending = fetch(`https://models.test/${model}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: options?.signal,
      });

      const response = await pending;

      if (!response.ok) throw new Error(`Model service returned ${response.status}`);

      return response.json();
    };

    // SAFETY: The production matching pipeline only consumes AI.run; this fixture routes it through workerd's outbound service.
    const ai = { run } as Ai;

    try {
      // OAuth is covered separately; this fixture exercises the actual MCP transport and tools.
      return await (new URL(request.url).pathname === "/mcp"
        ? recipeMcp(env.DB, ai, undefined, undefined, background).fetch(incoming)
        : server.fetch(incoming, { ...env, AI: ai }, background));
    } catch (error) {
      if (controller?.signal.aborted) return new Response(null, { status: 499 });
      throw error;
    }
  },
};
