import type { Env } from "./types";

export type AuthMode = "access-browser" | "api-key" | "unauthenticated";

export interface AccessIdentity {
  userId: string;
  email?: string;
  accessSubject?: string;
}

export interface AuthResult {
  mode: AuthMode;
  isAuthenticated: boolean;
  userId?: string;
  email?: string;
  accessSubject?: string;
}

type JwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
};

type JwtPayload = {
  sub?: string;
  email?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
};

type JwkKey = {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
};

const jwkCache = new Map<string, { keys: JwkKey[]; expiresAt: number }>();
const JWK_CACHE_TTL_MS = 5 * 60 * 1000;

export async function authenticateRequest(request: Request, env: Env): Promise<AuthResult> {
  const accessIdentity = await getVerifiedAccessIdentity(request, env);
  if (accessIdentity !== null) {
    return {
      mode: "access-browser",
      isAuthenticated: true,
      userId: accessIdentity.userId,
      email: accessIdentity.email,
      accessSubject: accessIdentity.accessSubject,
    };
  }

  const apiKey = getConfiguredApiKey(env);
  if (apiKey && hasValidApiKey(request, apiKey)) {
    return {
      mode: "api-key",
      isAuthenticated: true,
    };
  }

  return {
    mode: "unauthenticated",
    isAuthenticated: false,
  };
}

export function isAccessAuthenticated(request: Request): boolean {
  return getAccessIdentity(request) !== null;
}

export function getAccessIdentity(request: Request): AccessIdentity | null {
  const email = request.headers.get("Cf-Access-Authenticated-User-Email")?.trim() || undefined;
  const accessSubject =
    request.headers.get("Cf-Access-Authenticated-User-Id")?.trim() ||
    request.headers.get("Cf-Access-Authenticated-User-UUID")?.trim() ||
    undefined;
  const jwtAssertion = request.headers.get("Cf-Access-Jwt-Assertion")?.trim() || undefined;

  if (!email && !accessSubject && !jwtAssertion) {
    return null;
  }

  const userId = accessSubject || email;
  if (!userId) {
    return null;
  }

  return {
    userId,
    email,
    accessSubject,
  };
}

async function getVerifiedAccessIdentity(request: Request, env: Env): Promise<AccessIdentity | null> {
  const jwtAssertion = request.headers.get("Cf-Access-Jwt-Assertion")?.trim() || "";
  if (!jwtAssertion) {
    if (isLegacyHeaderFallbackAllowed(env)) {
      return getAccessIdentity(request);
    }
    return null;
  }

  try {
    const claims = await verifyAccessJwt(jwtAssertion, env);
    const userId = claims.sub || claims.email;
    if (!userId) return null;
    return {
      userId,
      email: claims.email,
      accessSubject: claims.sub,
    };
  } catch {
    return null;
  }
}

async function verifyAccessJwt(jwt: string, env: Env): Promise<JwtPayload> {
  const [encodedHeader, encodedPayload, encodedSignature] = jwt.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error("Malformed Access JWT");
  }

  const header = parseJwtPart<JwtHeader>(encodedHeader);
  const payload = parseJwtPart<JwtPayload>(encodedPayload);

  validateJwtClaims(payload, env);

  if ((header.alg || "").toUpperCase() !== "RS256") {
    throw new Error("Unsupported Access JWT algorithm");
  }

  const issuer = payload.iss?.trim();
  if (!issuer || !/^https:\/\/.+/i.test(issuer)) {
    throw new Error("Invalid Access JWT issuer");
  }

  const keys = await getAccessJwks(issuer);
  const verificationInput = `${encodedHeader}.${encodedPayload}`;
  const signatureBytes = base64UrlToBytes(encodedSignature);

  const candidateKeys = header.kid
    ? keys.filter((key) => key.kid === header.kid)
    : keys;

  for (const key of candidateKeys) {
    if (key.kty !== "RSA" || !key.n || !key.e) continue;
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "RSA",
        n: key.n,
        e: key.e,
        alg: "RS256",
        ext: true,
      },
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["verify"]
    );

    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signatureBytes as unknown as BufferSource,
      new TextEncoder().encode(verificationInput)
    );

    if (verified) {
      return payload;
    }
  }

  throw new Error("Access JWT signature verification failed");
}

function validateJwtClaims(payload: JwtPayload, env: Env): void {
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    throw new Error("Access JWT expired");
  }
  if (typeof payload.nbf === "number" && payload.nbf > now) {
    throw new Error("Access JWT not yet valid");
  }

  const expectedAud = getConfiguredAccessAudience(env);
  if (!expectedAud) return;

  const audClaim = payload.aud;
  const audiences = Array.isArray(audClaim) ? audClaim : typeof audClaim === "string" ? [audClaim] : [];
  if (!audiences.includes(expectedAud)) {
    throw new Error("Access JWT audience mismatch");
  }
}

async function getAccessJwks(issuer: string): Promise<JwkKey[]> {
  const cacheKey = issuer.replace(/\/$/, "");
  const cached = jwkCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys;
  }

  const certsUrl = `${cacheKey}/cdn-cgi/access/certs`;
  const response = await fetch(certsUrl, { method: "GET" });
  if (!response.ok) {
    throw new Error("Failed to fetch Access certs");
  }

  const body = await response.json() as { keys?: JwkKey[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  if (keys.length === 0) {
    throw new Error("No Access cert keys available");
  }

  jwkCache.set(cacheKey, {
    keys,
    expiresAt: Date.now() + JWK_CACHE_TTL_MS,
  });

  return keys;
}

function parseJwtPart<T>(value: string): T {
  const bytes = base64UrlToBytes(value);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as T;
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getConfiguredAccessAudience(env: Env): string | undefined {
  const vars = env as unknown as Record<string, unknown>;
  const value =
    (typeof vars["CF_ACCESS_AUD"] === "string" && vars["CF_ACCESS_AUD"]) ||
    (typeof vars["ACCESS_JWT_AUD"] === "string" && vars["ACCESS_JWT_AUD"]);
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isLegacyHeaderFallbackAllowed(env: Env): boolean {
  const vars = env as unknown as Record<string, unknown>;
  return vars["ACCESS_HEADER_FALLBACK"] === "true";
}

export function hasValidApiKey(request: Request, expectedApiKey: string): boolean {
  const xApiKey = request.headers.get("x-api-key")?.trim();
  if (xApiKey && xApiKey === expectedApiKey) return true;

  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization) return false;

  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const bearerToken = match?.[1]?.trim();
  return !!bearerToken && bearerToken === expectedApiKey;
}

function getConfiguredApiKey(env: Env): string | undefined {
  const vars = env as unknown as Record<string, unknown>;
  const key =
    (typeof vars["API_KEY"] === "string" && vars["API_KEY"]) ||
    (typeof vars["MVP_API_KEY"] === "string" && vars["MVP_API_KEY"]);

  if (!key) return undefined;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}