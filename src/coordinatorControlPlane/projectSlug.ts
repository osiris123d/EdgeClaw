/** URL-safe slug for display and future \`/projects/<slug>/\` export paths. */
export function slugifyProjectName(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "project";
}
