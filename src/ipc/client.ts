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

// ── credentials / profiles / tasks ─────────────────────────────────────────

export interface CredentialProfileView {
  id: string;
  label: string;
  authKind: "api_key" | "oauth_host" | "custom_provider";
  providerSlug: string | null;
  customProviderId: string | null;
  scope: string;
  keyFingerprint: string | null;
  hasSecret: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface HostAuthSummary {
  providerSlug: string;
  authType: string;
  isOauth: boolean;
  isAmbient: boolean;
}

export interface AgentProfileView {
  id: string;
  label: string;
  credentialProfileId: string;
  modelId: string | null;
  thinkingLevel: string | null;
}

export interface ResolvedAgentProfile {
  profile: AgentProfileView;
  origin: "task" | "workspace" | "app";
}

export interface TaskView {
  id: string;
  workspaceId: string;
  status: string;
  promptText: string;
  provider: string | null;
  model: string | null;
  profileOrigin: string | null;
  createdAt: number;
}

/** One item from the agent stream. Payload shapes are passthrough — see the
 * single normalization site in store/tasks.ts. */
export type StreamItem =
  | ({ kind: "event"; type: string } & Record<string, unknown>)
  | { kind: "unknown"; raw_type: string; raw: unknown }
  | { kind: "protocol_error"; reason: string; sample?: string }
  | { kind: "orphan_response"; command: string; success: boolean }
  | { kind: "oversize"; dropped_bytes: number }
  | { kind: "process_exited"; code: number | null; signal: number | null };

export interface TaskStreamEnvelope {
  taskId: string;
  seq: number;
  item: StreamItem;
}

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

  credsList: () => invoke<CredentialProfileView[]>("creds_list"),
  credsAdd: (input: {
    label: string;
    authKind: "api_key" | "oauth_host" | "custom_provider";
    providerSlug?: string;
    customProviderId?: string;
    scope?: string;
    apiKey?: string;
  }) => invoke<CredentialProfileView>("creds_add", { input }),
  credsDiscoverHostAuth: () => invoke<HostAuthSummary[]>("creds_discover_host_auth"),
  agentProfilesList: () => invoke<AgentProfileView[]>("agent_profiles_list"),
  agentProfilesUpsert: (input: {
    id?: string;
    label: string;
    credentialProfileId: string;
    modelId?: string;
    thinkingLevel?: string;
  }) => invoke<AgentProfileView>("agent_profiles_upsert", { input }),
  profilesSetDefault: (workspaceId: string | null, profileId: string | null) =>
    invoke<void>("profiles_set_default", { workspaceId, profileId }),
  profilesResolve: (workspaceId: string | null, taskOverride: string | null) =>
    invoke<ResolvedAgentProfile>("profiles_resolve", { workspaceId, taskOverride }),

  agentStopTask: (taskId: string, force: boolean) =>
    invoke<void>("agent_stop_task", { taskId, force }),
  agentSend: (taskId: string, command: "prompt" | "steer" | "follow_up", message: string) =>
    invoke<void>("agent_send", { taskId, command, message }),
  tasksRecent: (workspaceId: string) => invoke<TaskView[]>("tasks_recent", { workspaceId }),
};

export function onFsChanged(handler: (e: FsChanged) => void): Promise<UnlistenFn> {
  return listen<FsChanged>("fs://changed", (event) => handler(event.payload));
}

export function isConflict(e: unknown): e is { code: "file_conflict"; detail: { diskHash: string } } {
  return (
    typeof e === "object" && e !== null && (e as AppErrorShape).code === "file_conflict"
  );
}
