import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Namespace from "alchemy/Namespace";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const Database = Cloudflare.D1.Database("Database", {
  migrations: "./migrations",
});

export const Website = Cloudflare.Worker(
  "Website",
  Effect.gen(function* () {
    const { dev } = yield* AlchemyContext;

    let access: Cloudflare.Access.Application | undefined;
    let smoke: Cloudflare.Access.ServiceToken | undefined;

    if (!dev) {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        return yield* Effect.die(
          new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before deploying."),
        );
      }

      const google = yield* Cloudflare.Access.IdentityProvider("Google", {
        name: "Hearth Google",
        type: "google",
        config: { clientId, clientSecret },
      });

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
      main: "src/server.ts",
      access,
      domain: dev ? undefined : "hearth.joesaia.trade",
      compatibility: { date: "2026-09-08" },
      dev: { port: 8787 },
      assets: { directory: "./dist", notFoundHandling: "single-page-application", runWorkerFirst: true },
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

export default Alchemy.Stack(
  "hearth",
  {
    providers: Cloudflare.providers(),
    state: Layer.unwrap(
      Effect.map(AlchemyContext, ({ dev }) => (dev ? Alchemy.localState() : Cloudflare.state())),
    ),
  },
  Effect.gen(function* () {
    const website = yield* Website;

    return { url: website.url };
  }),
);
