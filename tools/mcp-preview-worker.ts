// Public CIMD fixture for live OAuth tests. Production uses src/mcp-worker.ts directly.
import worker, { type McpEnv } from "../src/mcp-worker";

export default {
  fetch(request: Request, env: McpEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.origin === env.MCP_ORIGIN && url.pathname === "/test-client.json") {
      return Response.json({
        client_id: `${env.MCP_ORIGIN}/test-client.json`,
        client_name: "Hearth preview evaluation",
        redirect_uris: ["http://localhost:3456/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    }
    return worker.fetch(request, env, ctx);
  },
};
