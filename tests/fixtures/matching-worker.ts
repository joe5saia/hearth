import server from "../../src/server";
import type { WebsiteEnv } from "../../alchemy.run";

// Integration-only upstream transport: the actual Worker/D1 pipeline consumes recorded wire formats.
// Real model accuracy is exercised separately by matching:eval against Cloudflare.
export default {
  fetch(request: Request, env: WebsiteEnv) {
    const run = async (
      model: string,
      input: Parameters<Ai["run"]>[1],
      options?: Parameters<Ai["run"]>[2],
    ) => {
      const response = await fetch(`https://models.test/${model}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: options?.signal,
      });

      if (!response.ok) throw new Error(`Model service returned ${response.status}`);

      return response.json();
    };

    // SAFETY: The production matching pipeline only consumes AI.run; this fixture routes it through workerd's outbound service.
    return server.fetch(request, { ...env, AI: { run } as Ai });
  },
};
