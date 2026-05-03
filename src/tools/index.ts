/**
 * Server-side tool registry.
 *
 * Think already injects built-in workspace tools (`read`, `write`, `edit`,
 * `list`, `find`, `grep`, `delete`) into each turn. This module only defines
 * additional custom tools that should be merged through `getTools()`.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  ToolApprovalEvaluator,
  defaultApprovalEvaluator,
} from "./approval";
import { secondsToIntervalExpression } from "../lib/taskScheduler";
import type { PersistedTask, CreateTaskInput } from "../lib/taskPersistence";

const PROJECT_NOTES_DIR = "/project-notes";
const MAX_SEARCH_FILES = 150;
const MAX_SEARCH_MATCHES = 40;
const MAX_SUMMARY_PREVIEW_LINES = 12;
const MAX_SEARCH_FILE_BYTES = 256_000;
/** Maximum byte length for a note title. */
const MAX_NOTE_TITLE_BYTES = 256;
/** Maximum byte length for note content to prevent memory exhaustion. */
const MAX_NOTE_CONTENT_BYTES = 128_000;
/** Maximum character length for a user-supplied regex pattern to limit backtracking risk. */
const MAX_REGEX_PATTERN_LENGTH = 200;

type WorkspaceEntryType = "file" | "directory" | "symlink";

interface WorkspaceStatLike {
  type: WorkspaceEntryType;
  size: number;
}

export interface WorkspaceLike {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  stat(path: string): Promise<WorkspaceStatLike | null>;
  glob(pattern: string): Promise<string[]>;
}

/**
 * Minimal interface for task management operations used by the chat tools.
 * Implemented by MainAgent — passed in via `AgentToolsOptions.taskAdapter`.
 */
export interface TaskToolAdapter {
  tasksCreate(input: CreateTaskInput): Promise<PersistedTask>;
  tasksGetAll(): PersistedTask[];
  tasksDelete(id: string): Promise<void>;
}

export interface AgentToolsOptions {
  workspace?: WorkspaceLike;
  approvalEvaluator?: ToolApprovalEvaluator;
  /** When provided, enables schedule_task / list_tasks / cancel_task tools. */
  taskAdapter?: TaskToolAdapter;
}

interface StoredProjectNote {
  id: string;
  title: string;
  content: string;
  tags: string[];
  updatedAt: string;
}

type AgentTool = ToolSet[string];

function buildToolSet(entries: Array<[string, AgentTool]>): ToolSet {
  return Object.fromEntries(entries) as ToolSet;
}

function requireWorkspace(workspace?: WorkspaceLike): WorkspaceLike {
  if (!workspace) {
    throw new Error(
      "Workspace is not available. These tools must run inside a Think agent instance."
    );
  }

  return workspace;
}

function slugifyNoteId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "note";
}

function getProjectNotePath(noteId: string): string {
  return `${PROJECT_NOTES_DIR}/${slugifyNoteId(noteId)}.json`;
}

/**
 * Reject paths that escape the project-notes sandbox via directory traversal.
 * `slugifyNoteId` already sanitises free-form IDs; this guard catches any
 * path that somehow still contains `..` sequences after slugification.
 */
function assertSafePath(path: string): void {
  if (path.includes("..") || path.includes("//")) {
    throw new Error(`Unsafe path rejected: "${path}"`);
  }
}

/**
 * Build a regex from a user-supplied pattern with a length cap to reduce
 * the risk of catastrophic backtracking (ReDoS).
 *
 * When `isRegex` is false the pattern is always literal-escaped, so no
 * user input ever reaches the RegExp engine as unescaped syntax.
 */
function buildSearchRegex(query: string, isRegex: boolean, caseSensitive: boolean): RegExp {
  if (isRegex) {
    if (query.length > MAX_REGEX_PATTERN_LENGTH) {
      throw new Error(
        `Regex pattern too long (${query.length} chars, max ${MAX_REGEX_PATTERN_LENGTH}).`
      );
    }
    return new RegExp(query, caseSensitive ? "g" : "gi");
  }
  // Literal search: escape all regex metacharacters so the query is treated verbatim.
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");
}

async function readStoredProjectNote(
  workspace: WorkspaceLike,
  notePath: string
): Promise<StoredProjectNote | null> {
  const stat = await workspace.stat(notePath);
  if (!stat || stat.type !== "file") {
    return null;
  }

  const raw = await workspace.readFile(notePath);
  return JSON.parse(raw) as StoredProjectNote;
}

function createPreview(lines: string[], limit: number): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, limit);
}

function detectStructure(lines: string[]): string[] {
  const markers = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("#")) {
      markers.add(trimmed);
    }

    const symbolMatch = trimmed.match(
      /^(export\s+)?(async\s+)?(function|class|interface|type|const|let)\s+([A-Za-z0-9_]+)/
    );
    if (symbolMatch) {
      markers.add(trimmed);
    }

    if (markers.size >= 8) {
      break;
    }
  }

  return Array.from(markers);
}

function createWorkspaceSummary(path: string, content: string, bytes: number) {
  const lines = content.split(/\r?\n/);
  const preview = createPreview(lines, MAX_SUMMARY_PREVIEW_LINES);
  const structure = detectStructure(lines);

  return {
    path,
    bytes,
    lineCount: lines.length,
    preview,
    structure,
    synopsis:
      structure.length > 0
        ? `File has ${lines.length} lines and exposes ${structure.length} notable headings or symbols.`
        : `File has ${lines.length} lines. Preview extracted from the first non-empty lines.`,
  };
}

export function createAgentTools(options: AgentToolsOptions = {}): ToolSet {
  const { workspace, approvalEvaluator = defaultApprovalEvaluator, taskAdapter } = options;

  return buildToolSet([
    [
      "save_project_note",
      tool({
        description:
          "Save or update a project-scoped note in the agent workspace. Use this for durable project facts, TODOs, and implementation notes.",
        inputSchema: z.object({
          title: z.string().min(1).max(MAX_NOTE_TITLE_BYTES).describe("Human-readable note title"),
          content: z.string().min(1).max(MAX_NOTE_CONTENT_BYTES).describe("Full note contents"),
          tags: z.array(z.string().min(1).max(64)).max(20).optional().describe("Optional tags for filtering and organization"),
        }),
        execute: async ({ title, content, tags = [] }) => {
          try {
            const activeWorkspace = requireWorkspace(workspace);
            const noteId = slugifyNoteId(title);
            const notePath = getProjectNotePath(noteId);
            assertSafePath(notePath);

            await activeWorkspace.mkdir(PROJECT_NOTES_DIR, { recursive: true });

            const note: StoredProjectNote = {
              id: noteId,
              title,
              content,
              tags,
              updatedAt: new Date().toISOString(),
            };

            await activeWorkspace.writeFile(notePath, JSON.stringify(note, null, 2));

            return {
              saved: true,
              noteId,
              path: notePath,
              tags,
              updatedAt: note.updatedAt,
            };
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      }),
    ],
    [
      "list_project_notes",
      tool({
        description:
          "List project notes previously stored by the agent. Use this before updating or deleting notes.",
        inputSchema: z.object({
          tag: z.string().optional().describe("Optional tag filter"),
        }),
        execute: async ({ tag }) => {
          try {
            const activeWorkspace = requireWorkspace(workspace);
            const notePaths = (await activeWorkspace.glob(`${PROJECT_NOTES_DIR}/*.json`)).sort();
            const notes: Array<Pick<StoredProjectNote, "id" | "title" | "tags" | "updatedAt">> = [];

            for (const notePath of notePaths) {
              const note = await readStoredProjectNote(activeWorkspace, notePath);
              if (!note) {
                continue;
              }

              if (tag && !note.tags.includes(tag)) {
                continue;
              }

              notes.push({
                id: note.id,
                title: note.title,
                tags: note.tags,
                updatedAt: note.updatedAt,
              });
            }

            return {
              count: notes.length,
              notes,
            };
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      }),
    ],
    [
      "delete_project_note",
      tool({
        description:
          "Delete a stored project note. This is destructive and must be approved by the client before execution.",
        inputSchema: z.object({
          noteId: z.string().min(1).max(MAX_NOTE_TITLE_BYTES).describe("Note identifier or title slug to delete"),
        }),
        needsApproval: approvalEvaluator.createNeedsApprovalChecker("delete_project_note"),
        execute: async ({ noteId }) => {
          try {
            const activeWorkspace = requireWorkspace(workspace);
            const notePath = getProjectNotePath(noteId);
            assertSafePath(notePath);
            const note = await readStoredProjectNote(activeWorkspace, notePath);

            if (!note) {
              return { error: `Project note not found: ${noteId}` };
            }

            await activeWorkspace.rm(notePath, { force: true });

            return {
              deleted: true,
              noteId: note.id,
              path: notePath,
            };
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      }),
    ],
    [
      "search_workspace",
      tool({
        description:
          "Search workspace file contents for a string or regular expression. Use this when you need a project-specific search result tailored for the agent.",
        inputSchema: z.object({
          query: z.string().min(1).max(MAX_REGEX_PATTERN_LENGTH).describe("Search text or regex pattern"),
          includePattern: z.string().max(256).optional().describe("Glob pattern for files to search"),
          isRegex: z.boolean().optional().describe("Treat query as a regular expression"),
          caseSensitive: z.boolean().optional().describe("Whether matching is case-sensitive"),
          maxMatches: z.number().int().min(1).max(MAX_SEARCH_MATCHES).optional().describe("Maximum number of matches to return"),
        }),
        execute: async ({
          query,
          includePattern = "/**/*",
          isRegex = false,
          caseSensitive = false,
          maxMatches = MAX_SEARCH_MATCHES,
        }) => {
          try {
            const activeWorkspace = requireWorkspace(workspace);
            const paths = (await activeWorkspace.glob(includePattern)).slice(0, MAX_SEARCH_FILES);
            let regex: RegExp;
            try {
              regex = buildSearchRegex(query, isRegex, caseSensitive);
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) };
            }
            const matches: Array<{ path: string; line: number; text: string }> = [];
            let filesSearched = 0;

            for (const path of paths) {
              if (matches.length >= maxMatches) {
                break;
              }

              const stat = await activeWorkspace.stat(path);
              if (!stat || stat.type !== "file" || stat.size > MAX_SEARCH_FILE_BYTES) {
                continue;
              }

              const content = await activeWorkspace.readFile(path);
              filesSearched += 1;
              const lines = content.split(/\r?\n/);

              for (let index = 0; index < lines.length; index += 1) {
                regex.lastIndex = 0;
                if (regex.test(lines[index])) {
                  matches.push({
                    path,
                    line: index + 1,
                    text: lines[index].trim(),
                  });
                }

                if (matches.length >= maxMatches) {
                  break;
                }
              }
            }

            return {
              query,
              includePattern,
              filesSearched,
              count: matches.length,
              matches,
              truncated: matches.length >= maxMatches,
            };
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      }),
    ],
    [
      "summarize_workspace_file",
      tool({
        description:
          "Read a workspace file and return a concise structural summary with preview lines and notable headings or symbols.",
        inputSchema: z.object({
          // Restrict path characters to prevent directory-traversal attempts.
          // The workspace readFile API is sandboxed, but an explicit deny on
          // ".." sequences adds a clear defensive layer at the schema boundary.
          path: z
            .string()
            .min(1)
            .max(1024)
            .refine((p) => !p.includes("..") && !p.includes("//"), {
              message: "Path must not contain '..' or '//' sequences.",
            })
            .describe("Absolute workspace path to summarize"),
        }),
        execute: async ({ path }) => {
          try {
            const activeWorkspace = requireWorkspace(workspace);
            const stat = await activeWorkspace.stat(path);

            if (!stat) {
              return { error: `File not found: ${path}` };
            }

            if (stat.type !== "file") {
              return { error: `${path} is not a file` };
            }

            const content = await activeWorkspace.readFile(path);
            return createWorkspaceSummary(path, content, stat.size);
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      }),
    ],

    // ── Task scheduling tools (only registered when taskAdapter is provided) ──
    ...(taskAdapter
      ? ([
          [
            "schedule_task",
            tool({
              description: `Create a new scheduled task. The agent will execute the given instructions at the specified schedule.

Supports four schedule types matching the Cloudflare Agents SDK:
  • "scheduled" — run once at a specific ISO 8601 datetime
  • "delayed"   — run once after N seconds from now
  • "cron"      — run on a 5-field cron expression (e.g. "0 9 * * 1-5" = weekdays at 9 AM)
  • "interval"  — run repeatedly every N seconds (e.g. 3600 = every hour)

Use natural language to infer the correct type and value from the user's request.`,
              inputSchema: z.object({
                title: z
                  .string()
                  .min(1)
                  .max(200)
                  .describe("Short descriptive name for the task"),
                instructions: z
                  .string()
                  .min(1)
                  .describe("What the agent should do each time this task runs"),
                when: z
                  .discriminatedUnion("type", [
                    z.object({
                      type: z.literal("scheduled"),
                      date: z
                        .string()
                        .describe("ISO 8601 datetime, e.g. 2026-06-15T09:00:00Z"),
                    }),
                    z.object({
                      type: z.literal("delayed"),
                      delayInSeconds: z
                        .number()
                        .int()
                        .positive()
                        .describe("Seconds from now until first execution"),
                    }),
                    z.object({
                      type: z.literal("cron"),
                      cron: z
                        .string()
                        .describe(
                          "5-field cron expression, e.g. '0 9 * * 1-5' for weekdays at 9 AM"
                        ),
                    }),
                    z.object({
                      type: z.literal("interval"),
                      intervalSeconds: z
                        .number()
                        .int()
                        .positive()
                        .describe("Seconds between executions, e.g. 3600 for every hour"),
                    }),
                  ])
                  .describe("When and how often the task should run"),
                timezone: z
                  .string()
                  .optional()
                  .describe("IANA timezone identifier, e.g. America/Chicago"),
                taskType: z
                  .enum(["reminder", "workflow", "follow_up", "other"])
                  .optional()
                  .describe("Category of task"),
                description: z
                  .string()
                  .optional()
                  .describe("Optional longer description visible in the Tasks UI"),
              }),
              execute: async ({ title, instructions, when, timezone, taskType, description }) => {
                try {
                  let scheduleType: "once" | "interval" | "cron";
                  let scheduleExpression: string;

                  switch (when.type) {
                    case "scheduled":
                      scheduleType = "once";
                      scheduleExpression = when.date;
                      break;
                    case "delayed":
                      scheduleType = "once";
                      scheduleExpression = new Date(
                        Date.now() + when.delayInSeconds * 1000
                      ).toISOString();
                      break;
                    case "cron":
                      scheduleType = "cron";
                      scheduleExpression = when.cron;
                      break;
                    case "interval":
                      scheduleType = "interval";
                      scheduleExpression = secondsToIntervalExpression(when.intervalSeconds);
                      break;
                  }

                  const input: CreateTaskInput = {
                    title,
                    instructions,
                    scheduleType,
                    scheduleExpression,
                    timezone,
                    taskType: taskType ?? "other",
                    description,
                    enabled: true,
                  };

                  const task = await taskAdapter.tasksCreate(input);
                  return {
                    created: true,
                    id: task.id,
                    title: task.title,
                    scheduleType: task.scheduleType,
                    scheduleExpression: task.scheduleExpression,
                    status: task.status,
                    nextRunAt: task.nextRunAt ?? null,
                  };
                } catch (error) {
                  return {
                    created: false,
                    error: error instanceof Error ? error.message : String(error),
                  };
                }
              },
            }),
          ],
          [
            "list_tasks",
            tool({
              description:
                "List all scheduled tasks. Returns title, schedule, status, and when each task last ran. Use this to check what tasks exist before creating a duplicate or to answer questions about upcoming scheduled work.",
              inputSchema: z.object({
                statusFilter: z
                  .enum(["active", "paused", "draft", "error", "all"])
                  .optional()
                  .default("all")
                  .describe("Filter by task status"),
              }),
              execute: async ({ statusFilter }) => {
                try {
                  const all = taskAdapter.tasksGetAll();
                  const filtered =
                    statusFilter === "all"
                      ? all
                      : all.filter((t) => t.status === statusFilter);

                  return {
                    count: filtered.length,
                    tasks: filtered.map((t) => ({
                      id: t.id,
                      title: t.title,
                      scheduleType: t.scheduleType,
                      scheduleExpression: t.scheduleExpression,
                      status: t.status,
                      enabled: t.enabled,
                      nextRunAt: t.nextRunAt ?? null,
                      lastRunAt: t.lastRunAt ?? null,
                      lastRunStatus: t.lastRunStatus ?? null,
                    })),
                  };
                } catch (error) {
                  return {
                    error: error instanceof Error ? error.message : String(error),
                  };
                }
              },
            }),
          ],
          [
            "cancel_task",
            tool({
              description:
                "Cancel and permanently delete a scheduled task by its ID. Use list_tasks first to find the correct task ID. Requires confirmation — always tell the user which task you are about to delete before calling this tool.",
              needsApproval: true,
              inputSchema: z.object({
                taskId: z.string().min(1).describe("The task ID to cancel and delete"),
                reason: z
                  .string()
                  .optional()
                  .describe("Optional reason for cancellation, shown in confirmation"),
              }),
              execute: async ({ taskId }) => {
                try {
                  await taskAdapter.tasksDelete(taskId);
                  return { cancelled: true, taskId };
                } catch (error) {
                  return {
                    cancelled: false,
                    error: error instanceof Error ? error.message : String(error),
                  };
                }
              },
            }),
          ],
        ] as Array<[string, ToolSet[string]]>)
      : []),
  ]);
}

interface RegisterCustomToolOptions<TInput extends z.ZodTypeAny> {
  description: string;
  inputSchema: TInput;
  execute: (input: z.infer<TInput>) => Promise<unknown>;
  needsApproval?: boolean;
}

export function registerCustomTool<TInput extends z.ZodTypeAny>(
  name: string,
  options: RegisterCustomToolOptions<TInput>
): ToolSet {
  return buildToolSet([
    [
      name,
      tool({
        description: options.description,
        inputSchema: options.inputSchema,
        needsApproval: options.needsApproval,
        execute: options.execute,
      }),
    ],
  ]);
}

export { ToolApprovalEvaluator, defaultApprovalEvaluator } from "./approval";
