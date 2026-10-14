import server from "../../src/server";
import { recipeMcp } from "../../src/mcp";
import type { WebsiteEnv } from "../../alchemy.run";

/**
 * Runs the real Worker/D1 and MCP pipelines against recorded upstream wire responses.
 * Real model accuracy belongs to matching:eval against Cloudflare, not this fixture.
 */
export default {
  /** Enables background work and request-only cancellation solely via integration-test headers. */
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

      // Forward JSON without validating model semantics: malformed model contracts must
      // reach the production decoder, and invalid JSON must retain its SyntaxError.
      return response.json();
    };

    // SAFETY: Ai requires unrelated methods and model-specific overloads that a wire
    // transport cannot implement. Only run is consumed by these real matching paths;
    // its input, options, and abort signal are forwarded above. ingredient-matching.test.ts
    // verifies HTTP/MCP matching, malformed output, upstream failures, and cancellation.
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
