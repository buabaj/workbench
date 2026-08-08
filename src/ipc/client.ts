import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ── types mirroring the Rust command surface (camelCase serde) ──────────────

export interface WorkspaceView {
  id: string;
  name: string;
  rootPath: string;
  kind: "git" | "plain";
}

export interface WorktreeChange {
  relPath: string;
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed" | "type_changed";
  insertions: number;
  deletions: number;
  isBinary: boolean;
  untracked: boolean;
}

export interface Paper {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  venue: string | null;
  abstractText: string | null;
  pdfUrl: string | null;
  landingUrl: string | null;
  citedBy: number;
  openAccess: boolean;
}

export interface ImportOutcome {
  relPath: string;
  pdfRelPath: string | null;
  alreadyHadIt: boolean;
  hasFullText: boolean;
}

/** Text from an internal capability, with the model that actually answered —
 *  which is not always the one asked for, since the chain falls back. */
export interface Completion {
  text: string;
  modelServed: string;
}

export interface LinkSuggestion {
  /** Always the name of a note that exists. */
  name: string;
  why: string;
}

export interface LinkSuggestions {
  suggestions: LinkSuggestion[];
  modelServed: string;
}

export interface CapabilityStatus {
  key: string;
  displayName: string;
  implemented: boolean;
  defaultModels: string[];
  effectiveModels: string[];
  /** Whether the model came from a choice made in Settings. */
  chosen: boolean;
}

export interface NoteDoc {
  relPath: string;
  text: string;
}

export interface BranchState {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface SearchQuery {
  pattern: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface SearchMatch {
  relPath: string;
  line: number;
  text: string;
  start: number;
  end: number;
}

export interface SearchProgress {
  matches: SearchMatch[];
  done: boolean;
  truncated: boolean;
}

export interface ReplaceOutcome {
  filesChanged: number;
  replacements: number;
}

export interface TreeNode {
  name: string;
  relPath: string;
  isDir: boolean;
  /** Excluded by gitignore — listed, but de-emphasised. */
  ignored: boolean;
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

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "type_changed";
export type Attribution = "agent_only" | "user_only" | "both" | "unknown";

export interface FileDiffSummary {
  relPath: string;
  oldPath: string | null;
  status: FileStatus;
  insertions: number;
  deletions: number;
  isBinary: boolean;
  attribution: Attribution;
}

export interface TaskDiff {
  files: FileDiffSummary[];
  skipped: string[];
  attributionDegraded: boolean;
}

export interface VoiceCapability {
  configured: boolean;
  modelIds: string[];
  privacyMode: string;
  credentialLabel: string | null;
}

export interface TranscriptResult {
  text: string;
  modelServed: string | null;
  durationMs: number;
  usage: unknown;
}

export interface ModelInfo {
  id: string;
  name: string;
  inputModalities: string[];
  outputModalities: string[];
  contextLength: number | null;
  pricePrompt: string | null;
}

export interface AgentCommand {
  name: string;
  description: string;
  kind: "action" | "skill" | "mode" | "command";
}

export interface ChatTurnRow {
  id: string;
  seq: number;
  role: string;
  text: string;
  errorText: string | null;
  createdAt: number;
}

export interface SessionSummary {
  taskId: string;
  title: string;
  status: string;
  turnCount: number;
  createdAt: number;
}

export interface AgentModel {
  id: string;
  provider: string;
  name: string | null;
  contextWindow: number;
  reasoning: boolean;
  outputCost: number | null;
  /** What auto-selection would choose. */
  recommended: boolean;
}

export interface AnchorSpec {
  relPath: string;
  from: number;
  to: number;
}

export type AnchorStatus = "ok" | "stale" | "broken";

export interface AnchorView {
  id: string;
  relPath: string;
  excerpt: string;
  status: AnchorStatus;
  confidence: number;
  from: number;
  to: number;
}

export interface LinkView {
  id: string;
  kind: string;
  note: string | null;
  src: AnchorView;
  dst: AnchorView;
  createdAt: number;
}

export interface FileLinks {
  outgoing: LinkView[];
  incoming: LinkView[];
}

export interface RestoreResult {
  restored: string[];
  trashed: string[];
  recreated: string[];
  refused: [string, string][];
  undoRef: string | null;
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
  searchReplace: (
    workspaceId: string,
    query: SearchQuery,
    replacement: string,
    relPaths: string[],
  ) => invoke<ReplaceOutcome>("search_replace", { workspaceId, query, replacement, relPaths }),
  worktreeChanges: (workspaceId: string) =>
    invoke<WorktreeChange[]>("worktree_changes", { workspaceId }),
  notesScan: (workspaceId: string) => invoke<NoteDoc[]>("notes_scan", { workspaceId }),
  /** Run an `@agent[...]` directive. Reports which model actually answered,
   *  so the note can record it rather than the one that was asked. */
  noteAction: (workspaceId: string, instruction: string, context: string) =>
    invoke<Completion>("note_action", {
      workspaceId,
      instruction,
      context,
    }),
  /** Tidy raw dictation. The caller keeps the raw text: this is an
   *  improvement, never a replacement it cannot undo. */
  transcriptCleanup: (text: string) => invoke<Completion>("transcript_cleanup", { text }),
  /** Summarise a note. Returned, not written — where it lands is the caller's. */
  researchSummarize: (text: string) => invoke<Completion>("research_summarize", { text }),
  /** Propose `[[links]]` from this note. `candidates` bounds the answer: the
   *  backend drops anything not in it, so a suggestion always names a real note. */
  linksSuggest: (text: string, candidates: string[]) =>
    invoke<LinkSuggestions>("links_suggest", { text, candidates }),
  capabilityStatus: () => invoke<CapabilityStatus[]>("capability_status"),
  /** An empty list resets the capability to its built-in default. */
  capabilityChooseModels: (capability: string, modelIds: string[]) =>
    invoke<void>("capability_choose_models", { capability, modelIds }),
  scholarSearch: (query: string, limit?: number) =>
    invoke<Paper[]>("scholar_search", { query, limit }),
  paperImport: (workspaceId: string, paper: Paper) =>
    invoke<ImportOutcome>("paper_import", { workspaceId, paper }),
  worktreeBranch: (workspaceId: string) =>
    invoke<BranchState>("worktree_branch", { workspaceId }),
  worktreePatch: (workspaceId: string, relPath: string) =>
    invoke<string>("worktree_patch", { workspaceId, relPath }),
  /** Proceed with quitting; the exit handler is holding for this. */
  confirmQuit: () => invoke<void>("confirm_quit"),
  /** Tell the exit handler a dialog is up, so its backstop does not fire. */
  quitAck: () => invoke<void>("quit_ack"),
  pathRename: (workspaceId: string, from: string, to: string) =>
    invoke<void>("path_rename", { workspaceId, from, to }),
  pathDuplicate: (workspaceId: string, from: string, to: string) =>
    invoke<void>("path_duplicate", { workspaceId, from, to }),
  pathTrash: (workspaceId: string, path: string) =>
    invoke<void>("path_trash", { workspaceId, path }),
  pathReveal: (workspaceId: string, path: string) =>
    invoke<void>("path_reveal", { workspaceId, path }),
  fileCreate: (workspaceId: string, path: string) =>
    invoke<void>("file_create", { workspaceId, path }),
  dirCreate: (workspaceId: string, path: string) =>
    invoke<void>("dir_create", { workspaceId, path }),
  agentPreflight: () => invoke<PreflightReport>("agent_preflight"),
  agentListModels: (credentialProfileId: string) =>
    invoke<AgentModel[]>("agent_list_models", { credentialProfileId }),
  agentProfileSetModel: (credentialProfileId: string, modelId: string) =>
    invoke<void>("agent_profile_set_model", { credentialProfileId, modelId }),
  /** Drop a workspace from recents. Keeps its conversations and checkpoints. */
  workspaceForget: (workspaceId: string) =>
    invoke<void>("workspace_forget", { workspaceId }),
  workspaceIndex: (workspaceId: string, refresh: boolean) =>
    invoke<string[]>("workspace_index", { workspaceId, refresh }),
  workspaceSettingGet: (workspaceId: string, key: string) =>
    invoke<unknown | null>("workspace_setting_get", { workspaceId, key }),
  workspaceSettingSet: (workspaceId: string, key: string, value: unknown) =>
    invoke<void>("workspace_setting_set", { workspaceId, key, value }),

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

  voiceCapability: () => invoke<VoiceCapability>("voice_capability"),
  voiceBegin: (sampleRate: number) => invoke<string>("voice_begin", { sampleRate }),
  voiceCancel: (sessionId: string) => invoke<void>("voice_cancel", { sessionId }),
  voiceFinish: (sessionId: string, language: string | null) =>
    invoke<TranscriptResult>("voice_finish", { sessionId, language }),
  voiceConfigure: (credentialProfileId: string, modelIds: string[], privacyMode: string) =>
    invoke<void>("voice_configure", { credentialProfileId, modelIds, privacyMode }),
  modelsForCapability: (capability: string) =>
    invoke<ModelInfo[]>("models_for_capability", { capability }),

  linkCreate: (
    workspaceId: string,
    kind: string,
    src: AnchorSpec,
    dst: AnchorSpec,
    note: string | null,
  ) => invoke<LinkView>("link_create", { workspaceId, kind, src, dst, note }),
  linkDelete: (id: string) => invoke<void>("link_delete", { id }),
  linksForFile: (workspaceId: string, relPath: string) =>
    invoke<FileLinks>("links_for_file", { workspaceId, relPath }),
  linkKinds: () => invoke<string[]>("link_kinds"),

  reviewTaskDiff: (taskId: string) => invoke<TaskDiff>("review_task_diff", { taskId }),
  reviewFilePatch: (taskId: string, relPath: string) =>
    invoke<string>("review_file_patch", { taskId, relPath }),
  reviewKeep: (taskId: string) => invoke<void>("review_keep", { taskId }),
  reviewRestore: (taskId: string, paths: string[]) =>
    invoke<RestoreResult>("review_restore", { taskId, paths }),
  reviewNoteUserEdit: (workspaceId: string, relPath: string) =>
    invoke<void>("review_note_user_edit", { workspaceId, relPath }),

  agentStopTask: (taskId: string, force: boolean) =>
    invoke<void>("agent_stop_task", { taskId, force }),
  agentSend: (taskId: string, command: "prompt" | "steer" | "follow_up", message: string) =>
    invoke<void>("agent_send", { taskId, command, message }),
  tasksRecent: (workspaceId: string) => invoke<TaskView[]>("tasks_recent", { workspaceId }),
  chatAppendTurn: (taskId: string, seq: number, role: string, text: string, errorText: string | null) =>
    invoke<void>("chat_append_turn", { taskId, seq, role, text, errorText }),
  chatTurns: (taskId: string) => invoke<ChatTurnRow[]>("chat_turns", { taskId }),
  chatSessions: (workspaceId: string) => invoke<SessionSummary[]>("chat_sessions", { workspaceId }),
  chatDeleteSession: (taskId: string) => invoke<void>("chat_delete_session", { taskId }),


  /** Name a conversation from its opening exchange, using the internal model. */
  chatTitle: (taskId: string) => invoke<string>("chat_title", { taskId }),

  agentCommands: (taskId: string | null) => invoke<AgentCommand[]>("agent_commands", { taskId }),
  agentAction: (taskId: string, action: string, argument: string | null) =>
    invoke<unknown>("agent_action", { taskId, action, argument }),
};

export function onFsChanged(handler: (e: FsChanged) => void): Promise<UnlistenFn> {
  return listen<FsChanged>("fs://changed", (event) => handler(event.payload));
}

/**
 * Tauri command errors arrive as the serde-tagged AppError:
 *   { code, detail }            for most variants
 *   { code: "app_ai", detail: { code, message } }
 * `String(e.detail)` on the nested shape produced "[object Object]" in the UI,
 * which told the user nothing. This unwraps to the most specific human string
 * available, whatever the depth.
 */
export function formatError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null) {
    const o = e as Record<string, unknown>;
    if (typeof o.message === "string") return o.message;
    if (o.detail !== undefined) {
      const inner = formatError(o.detail);
      if (inner && inner !== "[object Object]") {
        return typeof o.code === "string" && !inner.includes(o.code) ? inner : inner;
      }
    }
    if (typeof o.code === "string") return o.code.replace(/_/g, " ");
    try {
      return JSON.stringify(e);
    } catch {
      return "unknown error";
    }
  }
  return String(e);
}

export function isConflict(e: unknown): e is { code: "file_conflict"; detail: { diskHash: string } } {
  return (
    typeof e === "object" && e !== null && (e as AppErrorShape).code === "file_conflict"
  );
}
