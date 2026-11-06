import type { WorkspaceDescriptor } from "@/stores/session-store";

const WORKSPACE_ID_HEX_DIGITS = 16;

/**
 * The daemon accepts a workspace id chosen by the client, so the app can open a workspace before
 * the daemon has made anything: nothing has to be renamed when the real one arrives.
 */
export function mintWorkspaceId(): string {
  const digits = Array.from({ length: WORKSPACE_ID_HEX_DIGITS }, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
  return `wks_${digits.join("")}`;
}

interface StartingWorkspaceProject {
  projectId: string;
  projectDisplayName: string;
  projectCustomName?: string | null;
  projectRootPath: string;
  projectKind: WorkspaceDescriptor["projectKind"];
}

/** What the app shows and lists until the daemon sends the real workspace. It has no folder yet. */
export function buildStartingWorkspace(input: {
  id: string;
  project: StartingWorkspaceProject;
  worktreeSlug: string;
  createsWorktree: boolean;
  prompt: string;
  at: Date;
}): WorkspaceDescriptor {
  const { id, project, worktreeSlug, createsWorktree, prompt, at } = input;
  const firstLine = prompt.trim().split("\n")[0]?.trim();
  return {
    id,
    projectId: project.projectId,
    projectDisplayName: project.projectDisplayName,
    projectCustomName: project.projectCustomName ?? null,
    projectRootPath: project.projectRootPath,
    projectKind: project.projectKind,
    workspaceDirectory: "",
    workspaceKind: createsWorktree ? "worktree" : "directory",
    ...(createsWorktree ? { worktreeSlug } : {}),
    name: firstLine || worktreeSlug,
    status: "running",
    statusEnteredAt: at,
    createdAt: at,
    lastUserMessageAt: at,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    isStarting: true,
  };
}
