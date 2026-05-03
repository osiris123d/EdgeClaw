import { assembleBlueprintContextForCodingTask } from "../../coordinatorControlPlane/assembleBlueprintContextForCodingTask";
import type {
  BlueprintContextAssemblyMode,
  CodingCollaborationLoopInput,
} from "./codingLoopTypes";

/**
 * If {@link CodingCollaborationLoopInput.blueprintContextMarkdown} is already set, it wins (preformatted / escape hatch).
 * Else if {@link CodingCollaborationLoopInput.projectBlueprintPackage} is set, assemble task-scoped markdown
 * (with full-doc fallback inside {@link assembleBlueprintContextForCodingTask}).
 */
export function resolveCodingLoopBlueprintInjection(raw: CodingCollaborationLoopInput): {
  input: CodingCollaborationLoopInput;
  assembly: BlueprintContextAssemblyMode | undefined;
} {
  const md0 = raw.blueprintContextMarkdown?.trim();
  if (md0 && md0.length > 0) {
    const { projectBlueprintPackage: _omitPkg, ...rest } = raw;
    return {
      input: { ...rest, blueprintContextMarkdown: md0 },
      assembly: "preformatted",
    };
  }

  const pkg = raw.projectBlueprintPackage;
  if (!pkg) {
    return { input: raw, assembly: undefined };
  }

  const { markdown, mode } = assembleBlueprintContextForCodingTask(pkg, raw.task);
  const { projectBlueprintPackage: _omitPkg, ...rest } = raw;
  return {
    input: {
      ...rest,
      blueprintContextMarkdown: markdown,
    },
    assembly: mode,
  };
}
