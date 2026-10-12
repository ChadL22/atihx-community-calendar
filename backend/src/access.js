// Verifies the sign-in token Cloudflare Access attaches to every request it
// lets through to /admin and /api/admin. Checking it here (not just relying on
// Access at the edge) means the Worker can't be reached around Access.

let jwksCache = { url: '', keys: null, fetchedAt: 0 };

const b64urlToBytes = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

async function getKeys(teamDomain) {
  const url = `${teamDomain.replace(/\/$/, '')}/cdn-cgi/access/certs`;
  const fresh = Date.now() - jwksCache.fetchedAt < 60 * 60 * 1000;
  if (jwksCache.url === url && jwksCache.keys && fresh) return jwksCache.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load Access keys (${res.status})`);
  const { keys } = await res.json();
  jwksCache = { url, keys, fetchedAt: Date.now() };
  return keys;
}

/**
 * Returns the signed-in email address, or null if the request isn't
 * authenticated. In local development only, DEV_ADMIN_EMAIL stands in for a
 * real Access sign-in.
 */
export async function getAccessEmail(request, env) {
  if (env.ENVIRONMENT === 'development' && env.DEV_ADMIN_EMAIL) {
    return String(env.DEV_ADMIN_EMAIL).toLowerCase();
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;

  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ||
    (request.headers.get('Cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const header = b64urlToJson(parts[0]);
    const payload = b64urlToJson(parts[1]);
    if (header.alg !== 'RS256') return null;

    const keys = await getKeys(env.ACCESS_TEAM_DOMAIN);
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return null;

    const now = Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(env.ACCESS_AUD)) return null;
    if (payload.iss !== env.ACCESS_TEAM_DOMAIN.replace(/\/$/, '')) return null;
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;

    return payload.email ? String(payload.email).toLowerCase() : null;
  } catch (err) {
    console.error('Access token check failed:', err.message);
    return null;
  }
}
