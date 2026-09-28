import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet, type JWTPayload } from "jose";
import type server from "../src/server";

let signingKey: CryptoKey;

let publicKeys: JSONWebKeySet;

let worker: typeof server;

const assets = vi.fn(async () => new Response("Synthetic app"));

const fetchKeys = vi.fn();

const warning = vi.fn();

const unexpectedDatabase = () => {
  throw new Error("Root-path authentication tests must not access D1");
};

const env = {
  LOCAL_DEV: "false",
  ACCESS_AUD: "test-hearth",
  SMOKE_CLIENT_ID: "smoke-test.access",
  DB: {
    prepare: unexpectedDatabase,
    batch: unexpectedDatabase,
    exec: unexpectedDatabase,
    dump: unexpectedDatabase,
    withSession: unexpectedDatabase,
  },
  ASSETS: {
    fetch: assets,
    connect: () => {
      throw new Error("Unexpected asset connection");
    },
  },
} satisfies Parameters<typeof server.fetch>[1];

const sign = (claims: JWTPayload = {}, kid = "test-key") =>
  new SignJWT({
    iss: "https://saiaai.cloudflareaccess.com",
    aud: ["test-hearth"],
    sub: "",
    common_name: "smoke-test.access",
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .sign(signingKey);

const request = (token?: string, ray = "a4246a9ad9ed16a8-SJC") => {
  const headers = new Headers({
    "Cf-Ray": ray,
    Cookie: "private-cookie-not-for-logs",
    "CF-Access-Client-Secret": "private-secret-not-for-logs",
  });

  if (token) headers.set("Cf-Access-Jwt-Assertion", token);

  return new Request("https://hearth.example/", { headers });
};

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  signingKey = keys.privateKey;
  publicKeys = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "RS256" }] };
});

beforeEach(async () => {
  vi.resetModules();
  assets.mockClear();
  warning.mockClear();
  fetchKeys.mockReset().mockImplementation(async () => Response.json(publicKeys));
  vi.stubGlobal("fetch", fetchKeys);
  vi.spyOn(console, "warn").mockImplementation(warning);
  worker = (await import("../src/server")).default;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("loads assets on the first valid service navigation and caches successfully fetched keys", async () => {
  const token = await sign();

  for (let i = 0; i < 2; i++) {
    const response = await worker.fetch(request(token), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Synthetic app");
  }

  expect(fetchKeys).toHaveBeenCalledTimes(1);
  expect(new URL(fetchKeys.mock.calls[0][0]).href).toBe(
    "https://saiaai.cloudflareaccess.com/cdn-cgi/access/certs",
  );
  expect(warning).not.toHaveBeenCalled();
});

it.each([
  [
    "HTTP 503",
    () => Promise.resolve(new Response("Private upstream body", { status: 503 })),
    "ERR_JOSE_GENERIC",
  ],
  ["network rejection", () => Promise.reject(new TypeError("Private network details")), "TypeError"],
  [
    "timeout",
    () => Promise.reject(new DOMException("Private timeout details", "TimeoutError")),
    "ERR_JWKS_TIMEOUT",
  ],
])("reproduces a first-request 403 then recovery after a JWKS %s", async (_name, fail, code) => {
  fetchKeys.mockImplementationOnce(fail);
  const token = await sign();
  const denied = await worker.fetch(request(token), env);
  expect(denied.status).toBe(403);
  expect(await denied.text()).toBe("Cloudflare Access sign-in is required.");
  expect(denied.headers.get("Cache-Control")).toBe("no-store");
  expect(assets).not.toHaveBeenCalled();
  expect(warning.mock.calls).toEqual([
    [
      JSON.stringify({
        event: "access_verification_failed",
        reason: "verification_failed",
        code,
        assertionPresent: true,
        audienceConfigured: true,
        jwksFresh: false,
        cfRay: "a4246a9ad9ed16a8-SJC",
      }),
    ],
  ]);

  const recovered = await worker.fetch(request(token), env);
  expect(recovered.status).toBe(200);
  expect(await recovered.text()).toBe("Synthetic app");
  expect(fetchKeys).toHaveBeenCalledTimes(2);
});

it("distinguishes missing assertion and missing audience without fetching keys or leaking headers", async () => {
  expect((await worker.fetch(request(undefined, "private-invalid-ray"), env)).status).toBe(403);
  expect(JSON.parse(warning.mock.calls[0][0])).toEqual({
    event: "access_verification_failed",
    reason: "missing_assertion",
    code: null,
    assertionPresent: false,
    audienceConfigured: true,
    jwksFresh: false,
    cfRay: null,
  });
  expect((await worker.fetch(request(await sign()), { ...env, ACCESS_AUD: "" })).status).toBe(403);
  expect(JSON.parse(warning.mock.calls[1][0])).toMatchObject({
    reason: "missing_audience",
    assertionPresent: true,
    audienceConfigured: false,
  });
  expect(fetchKeys).not.toHaveBeenCalled();
  expect(assets).not.toHaveBeenCalled();
});

it("keeps missing keys in cooldown distinct from failed downloads", async () => {
  const token = await sign({}, "new-key");

  for (let i = 0; i < 2; i++) {
    expect((await worker.fetch(request(token), env)).status).toBe(403);
    expect(JSON.parse(warning.mock.calls[i][0])).toMatchObject({
      reason: "verification_failed",
      code: "ERR_JWKS_NO_MATCHING_KEY",
      jwksFresh: true,
    });
  }

  expect(fetchKeys).toHaveBeenCalledTimes(1);
  expect(assets).not.toHaveBeenCalled();
});

it("distinguishes claim validation and service authorization without logging claims", async () => {
  expect((await worker.fetch(request(await sign({ aud: "private-wrong-audience" })), env)).status).toBe(403);
  expect(JSON.parse(warning.mock.calls[0][0])).toMatchObject({
    reason: "verification_failed",
    code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
    jwksFresh: true,
  });
  expect(
    (await worker.fetch(request(await sign({ common_name: "private-unknown-service" })), env)).status,
  ).toBe(403);
  expect(JSON.parse(warning.mock.calls[1][0])).toMatchObject({
    reason: "unrecognized_service_identity",
    code: null,
    jwksFresh: true,
  });
  expect(JSON.stringify(warning.mock.calls)).not.toContain("private-");
  expect(assets).not.toHaveBeenCalled();
});
