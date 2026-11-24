import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

// Cloudflare Access JWT verification (SPEC.md §1). The Worker never trusts
// Cf-Access-Authenticated-User-Email; it verifies the signed assertion itself.

const jwksByUrl = new Map<string, JWTVerifyGetKey>();

export function accessCertsUrl(teamDomain: string): string {
  return `https://${teamDomain}/cdn-cgi/access/certs`;
}

function remoteJwks(teamDomain: string): JWTVerifyGetKey {
  const url = accessCertsUrl(teamDomain);
  let jwks = jwksByUrl.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    jwksByUrl.set(url, jwks);
  }
  return jwks;
}

/** Test hook: forget cached key sets. */
export function resetJwksCache(): void {
  jwksByUrl.clear();
}

export interface AccessConfig {
  teamDomain: string;
  aud: string;
  /** Defaults to the team's remote JWKS. */
  keys?: JWTVerifyGetKey;
}

export class AccessError extends Error {}

export async function verifyAccessJwt(token: string, cfg: AccessConfig): Promise<{ email: string }> {
  if (!cfg.teamDomain || !cfg.aud) throw new AccessError("access not configured");
  let payload;
  try {
    ({ payload } = await jwtVerify(token, cfg.keys ?? remoteJwks(cfg.teamDomain), {
      issuer: `https://${cfg.teamDomain}`,
      audience: cfg.aud,
      algorithms: ["RS256"],
      clockTolerance: 30,
    }));
  } catch (err) {
    throw new AccessError(err instanceof Error ? err.message : "invalid token");
  }
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email.includes("@")) throw new AccessError("token has no email");
  return { email };
}
