import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ── types mirroring the Rust command surface (camelCase serde) ──────────────

export interface WorkspaceView {
  id: string;
  name: string;
  rootPath: string;
  kind: "git" | "plain";
}

export interface TreeNode {
  name: string;
  relPath: string;
  isDir: boolean;
  kind: "research" | "code" | "other" | "dir";
}

export interface FileContents {
  relPath: string;
  text: string;
  contentHash: string;
  size: number;
  mtimeMs: number;
}

export interface FileStat {
  relPath: string;
  exists: boolean;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  contentHash: string | null;
}

export interface WriteOutcome {
  contentHash: string;
  mtimeMs: number;
}

export interface FsChanged {
  workspaceId: string;
  paths: string[];
  overflow: boolean;
}

export type PreflightLevel = "ok" | "warn" | "fail";

export interface PreflightCheck {
  id: string;
  level: PreflightLevel;
  title: string;
  detail: string | null;
  fix:
    | { kind: "copyCommand"; label: string; command: string }
    | { kind: "pickExecutable" }
    | { kind: "rescan" }
    | null;
}

export interface PreflightReport {
  ready: boolean;
  checks: PreflightCheck[];
  resolved: { program: string; pathEnv: string; source: string; version: string | null } | null;
  generatedAt: number;
}

export interface AppErrorShape {
  code: string;
  detail?: unknown;
}

// ── commands ────────────────────────────────────────────────────────────────

export const ipc = {
  workspacePick: () => invoke<WorkspaceView | null>("workspace_pick"),
  workspaceOpen: (path: string) => invoke<WorkspaceView>("workspace_open", { path }),
  workspaceRecent: () => invoke<WorkspaceView[]>("workspace_recent"),
  workspaceTree: (workspaceId: string, subpath?: string) =>
    invoke<TreeNode[]>("workspace_tree", { workspaceId, subpath: subpath ?? null }),
  fileRead: (workspaceId: string, path: string) =>
    invoke<FileContents>("file_read", { workspaceId, path }),
  fileStat: (workspaceId: string, path: string) =>
    invoke<FileStat>("file_stat", { workspaceId, path }),
  fileWrite: (
    workspaceId: string,
    path: string,
    text: string,
    expectedHash: string | null,
  ) => invoke<WriteOutcome>("file_write", { workspaceId, path, text, expectedHash }),
  agentPreflight: () => invoke<PreflightReport>("agent_preflight"),
};

export function onFsChanged(handler: (e: FsChanged) => void): Promise<UnlistenFn> {
  return listen<FsChanged>("fs://changed", (event) => handler(event.payload));
}

export function isConflict(e: unknown): e is { code: "file_conflict"; detail: { diskHash: string } } {
  return (
    typeof e === "object" && e !== null && (e as AppErrorShape).code === "file_conflict"
  );
}
