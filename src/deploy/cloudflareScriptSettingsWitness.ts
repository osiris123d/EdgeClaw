/**
 * Shared Cloudflare Workers **script-settings** GET — used by preview and production deploy witnesses only.
 * Does not upload bundles or create deployments.
 */

export interface CloudflareScriptSettingsWitnessOptions {
  accountId: string;
  apiToken: string;
  /** Wrangler `name` / Workers script name (e.g. edgeclaw-truth-agent). */
  workerScriptName: string;
  fetchFn?: typeof fetch;
}

/**
 * GET `/accounts/{account_id}/workers/scripts/{script_name}/script-settings` — lightweight JSON witness that the
 * API token can read/manage the target Worker script metadata.
 */
export async function fetchWorkerScriptSettingsWitness(
  options: CloudflareScriptSettingsWitnessOptions
): Promise<
  | { ok: true; tagsJoined: string }
  | { ok: false; error: string; httpStatus?: number }
> {
  const { accountId, apiToken, workerScriptName, fetchFn = globalThis.fetch.bind(globalThis) } = options;
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId.trim())}/workers/scripts/${encodeURIComponent(workerScriptName.trim())}/script-settings`;
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${apiToken.trim()}`,
        "Content-Type": "application/json",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Cloudflare script-settings request failed: ${msg}` };
  }

  const text = await res.text();
  type ScriptSettingsJson = {
    success?: boolean;
    errors?: { message?: string }[];
    result?: { tags?: string[] };
  };
  let json: ScriptSettingsJson;
  try {
    json = JSON.parse(text) as ScriptSettingsJson;
  } catch {
    return {
      ok: false,
      error: `Cloudflare script-settings response was not JSON (HTTP ${res.status})`,
      httpStatus: res.status,
    };
  }

  if (!res.ok || json.success === false) {
    const msg = json.errors?.[0]?.message ?? `HTTP ${res.status}`;
    return { ok: false, error: msg, httpStatus: res.status };
  }

  const tags = json.result?.tags;
  const tagsJoined = Array.isArray(tags) ? tags.filter((t) => typeof t === "string").join(",") : "";
  return { ok: true, tagsJoined };
}
