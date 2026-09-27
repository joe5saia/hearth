import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const Database = Cloudflare.D1.Database("Database", {
  migrations: "./migrations",
});

export const Website = Cloudflare.Worker(
  "Website",
  Effect.gen(function* () {
    const { dev } = yield* AlchemyContext;
    const password = process.env.HOUSEHOLD_PASSWORD ?? "";

    if (!dev && password.length < 10) {
      return yield* Effect.die(
        new Error("Set HOUSEHOLD_PASSWORD to at least 10 characters before deploying."),
      );
    }

    let access: Alchemy.Input<Cloudflare.WorkerAccessApplication> | undefined;
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
      const googleId = google.identityProviderId;
      access = {
        name: "Hearth",
        sessionDuration: "168h",
        allowedIdps: [googleId],
        autoRedirectToIdentity: true,
        previews: true,
        policies: [
          {
            name: "Household",
            decision: "allow",
            include: [{ email: "joe5saia@gmail.com" }, { email: "shannonnitroy@gmail.com" }],
            require: [{ loginMethod: googleId }],
          },
        ],
      };
    }

    return {
      main: "src/server.ts",
      access,
      compatibility: { date: "2026-09-08" },
      dev: { port: 8787 },
      assets: { directory: "./dist", notFoundHandling: "single-page-application", runWorkerFirst: true },
      env: {
        DB: Database,
        LOCAL_DEV: dev ? "true" : "false",
        HOUSEHOLD_PASSWORD: Redacted.make(dev ? "" : password),
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
