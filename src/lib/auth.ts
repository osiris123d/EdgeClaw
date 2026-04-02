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

export function authenticateRequest(request: Request, env: Env): AuthResult {
  const accessIdentity = getAccessIdentity(request);
  if (accessIdentity) {
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