import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Namespace from "alchemy/Namespace";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { workerRuntime } from "./cloudflare.config";

export const Database = Cloudflare.D1.Database("Database", {
  migrations: "./migrations",
});

// Keep the existing top-level Google resource identity when sharing it with MCP.
const Google = Effect.gen(function* () {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return yield* Effect.die(new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before deploying."));
  }

  return yield* Cloudflare.Access.IdentityProvider("Google", {
    name: "Hearth Google",
    type: "google",
    config: { clientId, clientSecret },
  });
});

export const Website = Cloudflare.Worker(
  "Website",
  Effect.gen(function* () {
    const { dev } = yield* AlchemyContext;

    let access: Cloudflare.Access.Application | undefined;
    let smoke: Cloudflare.Access.ServiceToken | undefined;

    if (!dev) {
      const google = yield* Google;

      smoke = yield* Cloudflare.Access.ServiceToken("SmokeTest", {
        name: "Hearth deployment smoke test",
        duration: "720h",
      });

      const googleId = google.identityProviderId;
      // Preserve the existing Website/Access resource and its audience tag.
      access = yield* Cloudflare.Access.Application("Access", {
        type: "self_hosted",
        name: "Hearth",
        sessionDuration: "168h",
        allowedIdps: [googleId],
        autoRedirectToIdentity: true,
        policies: [
          {
            name: "Deployment smoke test",
            decision: "non_identity",
            include: [{ serviceToken: smoke.serviceTokenId }],
          },
          {
            name: "Household",
            decision: "allow",
            include: [{ email: "joe5saia@gmail.com" }, { email: "shannonnitroy@gmail.com" }],
            require: [{ loginMethod: googleId }],
          },
        ],
      }).pipe(Namespace.push("Website"));
    }

    return {
      main: workerRuntime.main,
      access,
      domain: dev ? undefined : "hearth.joesaia.trade",
      compatibility: { date: workerRuntime.compatibilityDate },
      dev: { port: 8787 },
      assets: workerRuntime.assets,
      env: {
        DB: Database,
        LOCAL_DEV: dev ? "true" : "false",
        ACCESS_AUD: access?.aud ?? "",
        SMOKE_CLIENT_ID: smoke?.clientId ?? "",
      },
    } as const;
  }),
);

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;

export const McpOAuth = Cloudflare.KV.Namespace("McpOAuth");

export const Mcp = Cloudflare.Worker(
  "Mcp",
  Effect.gen(function* () {
    const google = yield* Google;
    const hostname = "hearth-mcp.joesaia.trade";

    const access = yield* Cloudflare.Access.Application("McpAccess", {
      type: "self_hosted",
      name: "Hearth MCP authorization",
      domain: `${hostname}/authorize`,
      sessionDuration: "168h",
      allowedIdps: [google.identityProviderId],
      autoRedirectToIdentity: true,
      appLauncherVisible: false,
      policies: [
        {
          name: "Household",
          decision: "allow",
          include: [{ email: "joe5saia@gmail.com" }, { email: "shannonnitroy@gmail.com" }],
          require: [{ loginMethod: google.identityProviderId }],
        },
      ],
    });

    return {
      main: "src/mcp-worker.ts",
      domain: hostname,
      workersDev: false,
      compatibility: {
        date: workerRuntime.compatibilityDate,
        flags: ["nodejs_compat", "global_fetch_strictly_public"],
      },
      // No Worker `access` enrollment: only /authorize belongs behind Access.
      env: {
        DB: Database,
        OAUTH_KV: McpOAuth,
        MCP_ORIGIN: `https://${hostname}`,
        ACCESS_AUD: access.aud,
      },
    } as const;
  }),
);

export default Alchemy.Stack(
  "hearth",
  {
    providers: Cloudflare.providers(),
    state: Layer.unwrap(
      Effect.map(AlchemyContext, ({ dev }) => (dev ? Alchemy.localState() : Cloudflare.state())),
    ),
  },
  Effect.gen(function* () {
    const { dev } = yield* AlchemyContext;
    const website = yield* Website;
    const mcp = dev ? undefined : yield* Mcp;

    return { url: website.url, mcp: mcp ? "https://hearth-mcp.joesaia.trade/mcp" : undefined };
  }),
);
