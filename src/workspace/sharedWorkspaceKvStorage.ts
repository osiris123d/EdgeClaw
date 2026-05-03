/**
 * KV **adapter** for `SharedWorkspaceStorage` — encapsulates key layout and legacy reads.
 * `SHARED_WORKSPACE_KV` is a deployment binding, not the architectural boundary (see `SharedWorkspaceStorage`).
 */

import type {
  PatchProposalRecord,
  SharedWorkspaceStorage,
} from "./sharedWorkspaceTypes";

function projRoot(projectId: string): string {
  return `sw/v1/proj/${encodeURIComponent(projectId)}`;
}

function keyFile(projectId: string, relativePath: string): string {
  return `${projRoot(projectId)}/files/${relativePath}`;
}

function keyPatch(projectId: string, patchId: string): string {
  return `${projRoot(projectId)}/patches/${encodeURIComponent(patchId)}`;
}

function prefixFiles(projectId: string): string {
  return `${projRoot(projectId)}/files/`;
}

function prefixPatches(projectId: string): string {
  return `${projRoot(projectId)}/patches/`;
}

function keyVerification(projectId: string, verificationId: string): string {
  return `${projRoot(projectId)}/verification/${encodeURIComponent(verificationId)}`;
}

function keyMeta(projectId: string): string {
  return `${projRoot(projectId)}/meta.json`;
}

/** Legacy patches were stored as raw diff text; migrate to structured records on read. */
function parsePatchProposal(raw: string | null): PatchProposalRecord | null {
  if (raw == null || raw === "") {
    return null;
  }
  try {
    const o = JSON.parse(raw) as PatchProposalRecord;
    if (
      o &&
      typeof o.body === "string" &&
      (o.status === "pending" ||
        o.status === "approved" ||
        o.status === "rejected" ||
        o.status === "applied")
    ) {
      return {
        status: o.status,
        body: o.body,
        updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : new Date().toISOString(),
        rejectReason: typeof o.rejectReason === "string" ? o.rejectReason : undefined,
      };
    }
  } catch {
    // legacy plain-text patch body
  }
  return {
    status: "pending",
    body: raw,
    updatedAt: new Date().toISOString(),
  };
}

async function kvListAllKeys(kv: KVNamespace, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      out.push(k.name);
    }
    if (!page.list_complete && page.cursor) {
      cursor = page.cursor;
    } else {
      break;
    }
  }
  return out;
}

export function createSharedWorkspaceKvStorage(kv: KVNamespace): SharedWorkspaceStorage {
  return {
    async readProjectFile(projectId: string, relativePath: string): Promise<string | null> {
      return kv.get(keyFile(projectId, relativePath));
    },

    async writeProjectFile(projectId: string, relativePath: string, content: string): Promise<void> {
      await kv.put(keyFile(projectId, relativePath), content);
    },

    async listProjectFiles(projectId: string, directoryPrefix: string): Promise<string[]> {
      const filesRoot = prefixFiles(projectId);
      const dir = directoryPrefix.replace(/^\/+/, "").replace(/\/+$/, "");
      const listPrefix = dir ? `${filesRoot}${dir}/` : filesRoot;
      const keys = await kvListAllKeys(kv, listPrefix);
      return keys.map((k) => {
        const rel = k.startsWith(filesRoot) ? k.slice(filesRoot.length) : k;
        return rel.replace(/\/+$/, "");
      });
    },

    async readPatchProposal(projectId: string, patchId: string): Promise<PatchProposalRecord | null> {
      const raw = await kv.get(keyPatch(projectId, patchId));
      return parsePatchProposal(raw);
    },

    async writePatchProposal(projectId: string, patchId: string, record: PatchProposalRecord): Promise<void> {
      await kv.put(keyPatch(projectId, patchId), JSON.stringify(record));
    },

    async listPatchProposalIds(projectId: string): Promise<string[]> {
      const prefix = prefixPatches(projectId);
      const keys = await kvListAllKeys(kv, prefix);
      const out: string[] = [];
      for (const k of keys) {
        const id = k.startsWith(prefix) ? k.slice(prefix.length) : "";
        if (id) {
          out.push(decodeURIComponent(id));
        }
      }
      return out;
    },

    async readVerification(projectId: string, verificationId: string): Promise<string | null> {
      return kv.get(keyVerification(projectId, verificationId));
    },

    async writeVerification(projectId: string, verificationId: string, payload: string): Promise<void> {
      await kv.put(keyVerification(projectId, verificationId), payload);
    },

    async readProjectMeta(projectId: string): Promise<string | null> {
      return kv.get(keyMeta(projectId));
    },

    async writeProjectMeta(projectId: string, metaJson: string): Promise<void> {
      await kv.put(keyMeta(projectId), metaJson);
    },
  };
}
