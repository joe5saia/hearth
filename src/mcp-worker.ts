import OAuthProvider, {
  type OAuthHelpers,
  type OAuthResourceContext,
  OAuthError,
  AuthorizationError,
  insufficientScope,
} from "@cloudflare/workers-oauth-provider";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { recipeMcp } from "./mcp";
import { consentPage } from "./mcp-consent";
import { observedFetch, type TelemetryEnv } from "./observability";

export interface McpEnv extends TelemetryEnv {
  DB: D1Database;
  AI?: Ai;
  OAUTH_KV: KVNamespace;
  MCP_ORIGIN: string;
  ACCESS_AUD: string;
  PREVIEW_CLIENT_ID?: string;
}

const issuer = "https://saiaai.cloudflareaccess.com";

const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

async function authorize(request: Request, env: McpEnv & { OAUTH_PROVIDER: OAuthHelpers }) {
  if (new URL(request.url).pathname !== "/authorize") return new Response("Not found", { status: 404 });
  let subject: string;

  try {
    const { payload } = await jwtVerify(request.headers.get("Cf-Access-Jwt-Assertion") ?? "", keys, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "sub"],
    });

    if (!env.ACCESS_AUD) throw new Error("Missing audience");

    if (payload.common_name !== undefined || !payload.sub) {
      if (!env.PREVIEW_CLIENT_ID || payload.common_name !== env.PREVIEW_CLIENT_ID)
        throw new Error("Service denied");
      subject = `preview-${env.PREVIEW_CLIENT_ID}`;
    } else {
      if (!["joe5saia@gmail.com", "shannonnitroy@gmail.com"].includes(String(payload.email)))
        throw new Error("Not household");
      subject = payload.sub;
    }
  } catch {
    return new Response("Household sign-in required.", { status: 403 });
  }

  const oauth = env.OAUTH_PROVIDER;

  try {
    if (request.method === "GET") {
      const auth = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(auth);
      const consent = await oauth.beginConsent(auth);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");

      return new Response(consentPage(details, consent.handle), { headers: consent.headers });
    }

    if (request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");

      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);

        return new Response(null, { status: 302, headers: denied.headers });
      }

      const approved = await oauth.approveConsent(request, handle, {
        scope: form.getAll("scope").map(String),
      });

      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: subject,
        metadata: {},
        scope: approved.request.scope,
        props: {},
      });

      approved.headers.set("Location", redirectTo);

      return new Response(null, { status: 302, headers: approved.headers });
    }

    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  } catch (error) {
    const clientError = error instanceof OAuthError || error instanceof AuthorizationError;

    return new Response(clientError ? error.message : "Authorization could not be completed. Start again.", {
      status: clientError ? 400 : 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export default {
  async fetch(request: Request, env: McpEnv, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;

    const operation = [
      "/mcp",
      "/authorize",
      "/oauth/token",
      "/oauth/register",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/mcp",
    ].includes(path)
      ? path.slice(1)
      : "unknown";

    return observedFetch(request, env, ctx, "hearth-mcp", operation, async (observation, tracer) => {
      if (new URL(request.url).origin !== env.MCP_ORIGIN)
        return new Response("Unknown origin", { status: 421 });

      const provider = new OAuthProvider<McpEnv>({
        apiRoute: "/mcp",
        apiHandler: {
          async fetch(request, env, context) {
            // SAFETY: OAuthProvider authenticates the token and supplies this resource context.
            const auth = (context as OAuthResourceContext<unknown>).auth;

            if (!auth.scope.includes("recipes")) return insufficientScope(auth, ["recipes"]);

            return recipeMcp(env.DB, env.AI, observation, tracer).fetch(request, {
              authInfo: {
                token: auth.token,
                clientId: auth.clientId ?? "",
                scopes: auth.scope,
                expiresAt: auth.expiresAt,
                resource: new URL(auth.audience),
              },
            });
          },
        },
        defaultHandler: {
          // SAFETY: OAuthProvider injects its documented OAuthHelpers binding before dispatch.
          fetch: (request, env) =>
            observation.step(
              "oauth.consent",
              () => authorize(request, env as McpEnv & { OAUTH_PROVIDER: OAuthHelpers }),
              tracer,
            ),
        },
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/oauth/token",
        clientRegistrationEndpoint: "/oauth/register",
        scopesSupported: ["recipes"],
        requiredScopes: ["recipes"],
        resourceMetadata: {
          resource: `${env.MCP_ORIGIN}/mcp`,
          authorization_servers: [env.MCP_ORIGIN],
        },
        clientIdMetadataDocumentEnabled: true,
      });

      const response = await observation.step(
        "oauth.dispatch",
        () => provider.fetch(request, env, ctx),
        tracer,
      );

      if (response.status >= 400)
        observation.event("oauth_failure", {
          operation,
          status: response.status,
          outcome: response.status >= 500 ? "error" : "rejected",
        });

      return response;
    });
  },
};
