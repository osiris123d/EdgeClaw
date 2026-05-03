/**
 * Minimal Cloudflare Workers account API helper — used by preview deploy URL resolution.
 * No Wrangler subprocess; suitable inside Workers runtime.
 */

/** GET /accounts/{account_id}/workers/subdomain */
export async function fetchWorkersAccountSubdomain(
  accountId: string,
  apiToken: string,
  fetchFn: typeof fetch
): Promise<string | null> {
  const res = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    return null;
  }
  const json = (await res.json()) as { success?: boolean; result?: { subdomain?: string } };
  const sub = json.result?.subdomain;
  return typeof sub === "string" && sub.trim() ? sub.trim() : null;
}

/**
 * Default workers.dev URL for a Worker script on the account subdomain.
 * Does not represent a versioned preview deployment — see deferred Workflow-driven deploy.
 */
export function buildWorkersDevUrl(workerScriptName: string, accountSubdomain: string): string {
  const script = workerScriptName.trim();
  const sub = accountSubdomain.trim();
  return `https://${script}.${sub}.workers.dev`;
}
