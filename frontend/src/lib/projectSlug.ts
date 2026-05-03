/** URL-safe slug; mirrors `src/coordinatorControlPlane/projectSlug.ts`. */
export function slugifyProjectName(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "project";
}
