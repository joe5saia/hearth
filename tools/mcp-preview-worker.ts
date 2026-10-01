// Public CIMD fixture for live OAuth tests. Production uses src/mcp-worker.ts directly.
import { createRemoteJWKSet, jwtVerify } from "jose";
import worker, { type McpEnv } from "../src/mcp-worker";
import { recipeMcp } from "../src/mcp";

interface PreviewEnv extends McpEnv {
  AMP_EVAL_PROJECT_ID: string;
  AMP_EVAL_USER_ID: string;
}

const issuer = "https://ampcode.com/api/workload-identity";
const keys = createRemoteJWKSet(new URL(`${issuer}/jwks.json`));

export default {
  async fetch(request: Request, env: PreviewEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.origin !== env.MCP_ORIGIN) return new Response("Unknown origin", { status: 421 });
    if (url.pathname === "/eval/mcp") {
      try {
        const token = request.headers.get("Authorization")?.match(/^Bearer (\S+)$/i)?.[1] ?? "";
        const { payload } = await jwtVerify(token, keys, {
          issuer,
          audience: env.MCP_ORIGIN,
          algorithms: ["RS256"],
          requiredClaims: ["exp", "sub", "project_id", "user_id", "thread_id", "token_use"],
        });
        if (
          !env.AMP_EVAL_PROJECT_ID || !env.AMP_EVAL_USER_ID ||
          payload.project_id !== env.AMP_EVAL_PROJECT_ID || payload.user_id !== env.AMP_EVAL_USER_ID ||
          payload.token_use !== "exchanged" || typeof payload.thread_id !== "string" || !payload.thread_id ||
          typeof payload.sub !== "string" || !payload.sub
        ) throw new Error("Identity denied");
        return recipeMcp(env.DB).fetch(request, {
          authInfo: { token, clientId: payload.thread_id, scopes: ["recipes"], expiresAt: payload.exp!, resource: new URL(`${env.MCP_ORIGIN}/eval/mcp`) },
        });
      } catch {
        return Response.json({ error: "invalid_token" }, {
          status: 401, headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" },
        });
      }
    }
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
