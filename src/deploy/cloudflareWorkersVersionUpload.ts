/**
 * Cloudflare Workers **Versions** API — multipart upload (orchestrator-only use).
 * @see https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/
 */

export interface WorkersVersionUploadOk {
  versionId: string;
  /** From API payload when present (embedded URLs), else extracted from JSON scan */
  previewUrl?: string;
  /** Cloudflare `metadata.hasPreview` when present */
  hasPreview?: boolean;
}

export interface WorkersVersionUploadParams {
  accountId: string;
  apiToken: string;
  /** Target Worker **script name** — use a DO-free preview Worker (see preview-deploy-cloudflare.md). */
  uploadScriptName: string;
  manifestDigest: string;
  bundleId: string;
  /** Workers compatibility_date (match stub Worker capabilities). */
  compatibilityDate: string;
  fetchFn?: typeof fetch;
}

function extractWorkersDevUrls(raw: unknown): string[] {
  const seen = new Set<string>();
  const key = JSON.stringify(raw);
  const re = /https:\/\/[a-zA-Z0-9][-a-zA-Z0-9._]*workers\.dev[^\s"]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(key)) !== null) {
    seen.add(m[0]);
  }
  return [...seen];
}

/** Minimal ES module Worker — no DO/KV; binds promotion digest as plain_text for auditability. */
export function buildPromotionPreviewStubWorkerSource(): string {
  return `export default {
  async fetch(request, env) {
    const body = {
      edgeclawPromotionPreview: true,
      manifestDigest: env.MANIFEST_DIGEST ?? "",
      bundleId: env.BUNDLE_ID ?? "",
    };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },
};
`;
}

/**
 * POST multipart `/accounts/{account}/workers/scripts/{script}/versions`
 */
export async function uploadWorkersPromotionPreviewVersion(
  params: WorkersVersionUploadParams
): Promise<
  | { ok: true; data: WorkersVersionUploadOk }
  | { ok: false; error: string; httpStatus?: number }
> {
  const {
    accountId,
    apiToken,
    uploadScriptName,
    manifestDigest,
    bundleId,
    compatibilityDate,
    fetchFn = globalThis.fetch.bind(globalThis),
  } = params;

  const trimmedScript = uploadScriptName.trim();
  if (!trimmedScript) {
    return { ok: false, error: "uploadScriptName is empty" };
  }

  const meta = {
    main_module: "worker.js",
    compatibility_date: compatibilityDate.trim() || "2025-01-14",
    bindings: [
      { type: "plain_text", name: "MANIFEST_DIGEST", text: manifestDigest.trim() },
      { type: "plain_text", name: "BUNDLE_ID", text: bundleId.trim() },
    ],
  };

  const fd = new FormData();
  fd.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
  fd.append(
    "worker.js",
    new Blob([buildPromotionPreviewStubWorkerSource()], {
      type: "application/javascript",
    }),
    "worker.js"
  );

  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId.trim())}/workers/scripts/${encodeURIComponent(trimmedScript)}/versions`;

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken.trim()}`,
      },
      body: fd,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Workers version upload fetch failed: ${msg}` };
  }

  const text = await res.text();
  type CfVersionCreateResponse = {
    success?: boolean;
    errors?: { message?: string }[];
    result?: {
      id?: string;
      metadata?: { hasPreview?: boolean };
    };
  };
  let json: CfVersionCreateResponse;
  try {
    json = JSON.parse(text) as CfVersionCreateResponse;
  } catch {
    return {
      ok: false,
      error: `Workers version upload response was not JSON (HTTP ${res.status})`,
      httpStatus: res.status,
    };
  }

  if (!res.ok || json.success === false) {
    const msg = json.errors?.[0]?.message ?? `HTTP ${res.status}`;
    return { ok: false, error: msg, httpStatus: res.status };
  }

  const versionId = json.result?.id?.trim();
  if (!versionId) {
    return { ok: false, error: "Workers version upload succeeded but result.id missing", httpStatus: res.status };
  }

  const urls = extractWorkersDevUrls(json);
  const previewUrl = urls[0];
  return {
    ok: true,
    data: {
      versionId,
      previewUrl,
      hasPreview: json.result?.metadata?.hasPreview,
    },
  };
}
