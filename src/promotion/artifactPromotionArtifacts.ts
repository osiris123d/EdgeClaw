/**
 * Cloudflare Artifacts-backed {@link ArtifactPromotionWriter}.
 *
 * Stores each promotion manifest as an immutable JSON blob at the **same logical path** as the R2 object key
 * (`buildPromotionManifestR2ObjectKey`) inside a dedicated Artifacts git repository. Writes use isomorphic-git +
 * {@link ArtifactsMemoryFs} per Cloudflare docs — compatible with standard git clients via repo `remote`.
 *
 * **Deferred / ops:** Large manifests or high-frequency writes pay clone+push cost; consider batching or a future
 * native blob API if Cloudflare exposes one. Requires `artifacts` binding + opt-in env flag (see factory).
 */

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type {
  ArtifactPromotionWriter,
  PromotionArtifactManifest,
  PromotionArtifactRef,
} from "./artifactPromotionTypes";
import { buildPromotionManifestR2ObjectKey } from "./artifactPromotionR2";
import {
  canonicalPromotionManifestPayload,
  computePromotionManifestDigest,
} from "./promotionManifestCanonical";
import { ArtifactsMemoryFs } from "./artifactsMemoryFs";

function tokenSecretForGitAuth(fullToken: string): string {
  const idx = fullToken.indexOf("?expires=");
  return idx >= 0 ? fullToken.slice(0, idx) : fullToken;
}

function posixDirname(path: string): string {
  const n = path.replace(/\/+$/, "");
  const i = n.lastIndexOf("/");
  return i <= 0 ? "" : n.slice(0, i);
}

function isPromotionArtifactManifest(value: unknown): value is PromotionArtifactManifest {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    o.schemaVersion === "edgeclaw-promotion-v1" &&
    typeof o.bundleId === "string" &&
    typeof o.projectId === "string" &&
    typeof o.createdAt === "string" &&
    Array.isArray(o.patchIds)
  );
}

/**
 * `artifacts://<repoName>/<url-encoded-relative-path>` — mirrors R2 key layout inside the git repo root.
 */
export function buildPromotionArtifactsStorageUri(repoName: string, relativeManifestPath: string): string {
  return `artifacts://${repoName}/${encodeURIComponent(relativeManifestPath)}`;
}

export function parsePromotionArtifactsStorageUri(
  uri: string,
  expectedRepoName: string
): { relativePath: string } | null {
  const prefix = `artifacts://${expectedRepoName}/`;
  if (!uri.startsWith(prefix)) {
    return null;
  }
  const encoded = uri.slice(prefix.length);
  try {
    return { relativePath: decodeURIComponent(encoded) };
  } catch {
    return null;
  }
}

async function gitPushPromotionManifest(params: {
  remoteUrl: string;
  /** Full token (`art_v1_…?expires=…`) */
  tokenPlaintext: string;
  relativePath: string;
  bodyText: string;
  commitMessage: string;
  emptyRemote: boolean;
}): Promise<{ commitOid: string }> {
  const fs = new ArtifactsMemoryFs();
  const dir = "/repo";
  const onAuth = () => ({
    username: "x",
    password: tokenSecretForGitAuth(params.tokenPlaintext),
  });

  if (params.emptyRemote) {
    await git.init({ fs, dir, defaultBranch: "main" });
    await git.addRemote({ fs, dir, remote: "origin", url: params.remoteUrl });
    const parent = posixDirname(params.relativePath);
    if (parent) {
      await fs.promises.mkdir(`${dir}/${parent}`, { recursive: true });
    }
    await fs.promises.writeFile(`${dir}/${params.relativePath}`, params.bodyText);
    await git.add({ fs, dir, filepath: params.relativePath });
    const commitOid = await git.commit({
      fs,
      dir,
      message: params.commitMessage,
      author: {
        name: "EdgeClaw Promotion",
        email: "promotion@edgeclaw.local",
      },
    });
    await git.push({
      fs,
      http,
      dir,
      remote: "origin",
      url: params.remoteUrl,
      ref: "main",
      onAuth,
    });
    return { commitOid };
  }

  await git.clone({
    fs,
    http,
    dir,
    url: params.remoteUrl,
    depth: 1,
    singleBranch: true,
    ref: "main",
    onAuth,
  });

  const parent = posixDirname(params.relativePath);
  if (parent) {
    await fs.promises.mkdir(`${dir}/${parent}`, { recursive: true });
  }
  await fs.promises.writeFile(`${dir}/${params.relativePath}`, params.bodyText);
  await git.add({ fs, dir, filepath: params.relativePath });
  const commitOid = await git.commit({
    fs,
    dir,
    message: params.commitMessage,
    author: {
      name: "EdgeClaw Promotion",
      email: "promotion@edgeclaw.local",
    },
  });
  await git.push({
    fs,
    http,
    dir,
    remote: "origin",
    url: params.remoteUrl,
    ref: "main",
    onAuth,
  });
  return { commitOid };
}

async function gitReadPromotionManifest(params: {
  remoteUrl: string;
  tokenPlaintext: string;
  relativePath: string;
}): Promise<string | null> {
  const fs = new ArtifactsMemoryFs();
  const dir = "/read";
  const onAuth = () => ({
    username: "x",
    password: tokenSecretForGitAuth(params.tokenPlaintext),
  });
  try {
    await git.clone({
      fs,
      http,
      dir,
      url: params.remoteUrl,
      depth: 1,
      singleBranch: true,
      ref: "main",
      onAuth,
    });
    const text = await fs.promises.readFile(`${dir}/${params.relativePath}`, "utf8");
    return typeof text === "string" ? text : new TextDecoder().decode(text as Uint8Array);
  } catch {
    return null;
  }
}

/**
 * @param artifacts Workers Artifacts binding
 * @param options.repoName Repository dedicated to promotion manifests (alphanumeric, dots, hyphens, underscores).
 */
export function createArtifactsArtifactPromotionWriter(
  artifacts: Artifacts,
  options: { repoName: string }
): ArtifactPromotionWriter {
  const repoName = options.repoName.trim();

  return {
    async writeManifest(manifest: PromotionArtifactManifest): Promise<PromotionArtifactRef> {
      const payload = canonicalPromotionManifestPayload(manifest);
      const bodyText = JSON.stringify(payload);
      const manifestDigest = await computePromotionManifestDigest(manifest);
      const relativePath = buildPromotionManifestR2ObjectKey(manifest.projectId, manifest.bundleId);

      let remoteUrl: string;
      let writeToken: string;
      let emptyRemote: boolean;

      try {
        const repo = await artifacts.get(repoName);
        remoteUrl = repo.remote;
        emptyRemote = false;
        const tok = await repo.createToken("write", 7200);
        writeToken = tok.plaintext;
      } catch {
        try {
          const created = await artifacts.create(repoName, {
            description: "EdgeClaw promotion manifests (immutable JSON per bundle path)",
            setDefaultBranch: "main",
          });
          remoteUrl = created.remote;
          writeToken = created.token;
          emptyRemote = true;
        } catch {
          const repo = await artifacts.get(repoName);
          remoteUrl = repo.remote;
          emptyRemote = false;
          const tok = await repo.createToken("write", 7200);
          writeToken = tok.plaintext;
        }
      }

      const { commitOid } = await gitPushPromotionManifest({
        remoteUrl,
        tokenPlaintext: writeToken,
        relativePath,
        bodyText,
        commitMessage: `promotion: bundle ${manifest.bundleId} (${manifest.projectId})`,
        emptyRemote,
      });

      const storageUri = buildPromotionArtifactsStorageUri(repoName, relativePath);

      return {
        bundleId: manifest.bundleId,
        storageUri,
        manifestDigest,
        writtenAt: new Date().toISOString(),
        storageBackend: "workers-artifacts",
        objectVersion: commitOid,
      };
    },

    async readManifest(ref: PromotionArtifactRef): Promise<PromotionArtifactManifest | null> {
      const parsed = parsePromotionArtifactsStorageUri(ref.storageUri ?? "", repoName);
      if (!parsed) {
        return null;
      }
      let repoHandle: ArtifactsRepo;
      try {
        repoHandle = await artifacts.get(repoName);
      } catch {
        return null;
      }
      const tok = await repoHandle.createToken("read", 3600);
      const text = await gitReadPromotionManifest({
        remoteUrl: repoHandle.remote,
        tokenPlaintext: tok.plaintext,
        relativePath: parsed.relativePath,
      });
      if (!text) {
        return null;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return null;
      }
      if (!isPromotionArtifactManifest(raw)) {
        return null;
      }
      const m = raw;
      if (m.bundleId !== ref.bundleId) {
        return null;
      }
      const digest = await computePromotionManifestDigest(m);
      if (ref.manifestDigest) {
        if (digest.toLowerCase() !== ref.manifestDigest.trim().toLowerCase()) {
          return null;
        }
      }
      return m;
    },
  };
}
