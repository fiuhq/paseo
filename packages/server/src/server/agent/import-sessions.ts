import { stat } from "node:fs/promises";
import type { z } from "zod";
import type { Logger } from "pino";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import type {
  AgentManager,
  ManagedAgent,
  ManagedImportableProviderSession,
} from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import type { AgentPersistenceHandle, AgentProvider } from "./agent-sdk-types.js";
import { ensureAgentLoaded, type AgentLoaderManager } from "./agent-loading.js";
import { unarchiveAgentState } from "./agent-prompt.js";
import { toRecentProviderSessionDescriptorPayload } from "./agent-projections.js";
import type { WorkspaceProvisioningService } from "../session/workspace-provisioning/workspace-provisioning-service.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type {
  FetchRecentProviderSessionsRequestMessage,
  ImportAgentRequestMessageSchema,
  RecentProviderSessionDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { getParentAgentIdFromLabels, PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createRealpathAwarePathMatcher } from "../../utils/path.js";

type ImportAgentRequestMessage = z.infer<typeof ImportAgentRequestMessageSchema>;

const METADATA_GENERATION_PROMPT_PREFIX =
  "Generate metadata for a coding agent based on the user prompt.";
const IMPORT_SESSION_SEARCH_SCAN_LIMIT = 500;
export type ImportSessionAgentManager = AgentLoaderManager &
  Pick<
    AgentManager,
    | "archiveSnapshot"
    | "closeAgent"
    | "getTimeline"
    | "importProviderSession"
    | "notifyAgentState"
    | "unarchiveSnapshot"
  >;

const providerSessionImportMutations = new WeakMap<
  ImportSessionAgentManager,
  Map<string, Promise<unknown>>
>();

export interface NormalizedImportAgentRequest {
  provider: AgentProvider;
  providerHandleId: string;
  cwd?: string;
  workspaceId?: string;
  labels?: Record<string, string>;
  requestId: string;
}

export class ImportSessionsRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportSessionsRequestError";
  }
}

export interface ListImportableProviderSessionsInput {
  request: FetchRecentProviderSessionsRequestMessage;
  agentManager: Pick<AgentManager, "listAgents" | "listImportableSessions">;
  agentStorage: Pick<AgentStorage, "listAll">;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "getProviderLabel">;
  /** Whether a session's directory is still there; a session whose directory is gone can't be imported. */
  sessionDirectoryExists?: (cwd: string) => Promise<boolean>;
}

export interface ListImportableProviderSessionsResult {
  entries: RecentProviderSessionDescriptorPayload[];
  filteredAlreadyImportedCount: number;
  providerErrors: Array<{ provider: string; message: string }>;
}

export interface ImportProviderSessionInput {
  request: NormalizedImportAgentRequest;
  workspaceProvisioning: Pick<WorkspaceProvisioningService, "runInImportWorkspace">;
  agentManager: ImportSessionAgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}

export interface ImportProviderSessionResult {
  snapshot: ManagedAgent;
  timelineSize: number;
  createdWorkspace: PersistedWorkspaceRecord | null;
}

interface ImportedProviderSession {
  snapshot: ManagedAgent;
  timelineSize: number;
}

// COMPAT(import-agent-request-v1): accept legacy {provider, sessionId} shape
// alongside the new {providerId, providerHandleId} shape. Old clients
// (< target daemon floor) send the legacy fields. Drop the fallbacks and the
// .optional() in messages.ts when the supported client floor is >= the daemon
// version that ships the new shape (target: 2026-11-08).
export function normalizeImportAgentRequest(
  msg: ImportAgentRequestMessage,
): NormalizedImportAgentRequest | { error: string } {
  const provider = msg.providerId ?? msg.provider;
  const providerHandleId = msg.providerHandleId ?? msg.sessionId;
  if (!provider || !providerHandleId) {
    return { error: "Import requires providerId and providerHandleId" };
  }
  return {
    provider: provider as AgentProvider,
    providerHandleId,
    cwd: msg.cwd,
    workspaceId: msg.workspaceId,
    labels: msg.labels,
    requestId: msg.requestId,
  };
}

export async function listImportableProviderSessions(
  input: ListImportableProviderSessionsInput,
): Promise<ListImportableProviderSessionsResult> {
  const { request, agentManager, agentStorage, providerSnapshotManager } = input;
  const limit = request.limit ?? 20;
  const sinceTimestamp = parseRecentProviderSessionsSince(request.since);
  const providerFilter = request.providers ? new Set(request.providers) : undefined;
  const importedSessions = await collectImportedProviderSessions(
    agentManager,
    agentStorage,
    providerFilter,
  );
  const importedHandles = importedSessions.handles;
  const query = normalizeImportSessionQuery(request.query);
  const listingLimit = query ? IMPORT_SESSION_SEARCH_SCAN_LIMIT : limit + importedSessions.count;

  const listing = await agentManager.listImportableSessions({
    limit: listingLimit,
    ...(query ? { query } : {}),
    ...(query ? { scanLimit: IMPORT_SESSION_SEARCH_SCAN_LIMIT } : {}),
    providerFilter,
    cwd: request.cwd,
  });
  let filteredAlreadyImportedCount = 0;
  const candidates: Array<ManagedImportableProviderSession & { importedAgentId?: string }> = [];
  const matchesRequestCwd = request.cwd ? createRealpathAwarePathMatcher(request.cwd) : null;
  for (const session of listing.sessions) {
    if (matchesRequestCwd && !matchesRequestCwd(session.cwd)) {
      continue;
    }
    if (sinceTimestamp !== null && session.lastActivityAt.getTime() < sinceTimestamp) {
      continue;
    }
    if (isMetadataGenerationSession(session)) {
      continue;
    }
    const handleKey = toProviderSessionHandleKey(session.provider, session.providerHandleId);
    if (importedHandles.has(handleKey)) {
      const importedAgentId = importedHandles.get(handleKey);
      // A search is someone looking for one session: show it with the agent that has it open,
      // so the sheet can take them there. The recent list leaves it out.
      if (query && importedAgentId) {
        candidates.push(Object.assign(session, { importedAgentId }));
        continue;
      }
      filteredAlreadyImportedCount += 1;
      continue;
    }
    candidates.push(session);
  }

  candidates.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  const entries = (
    await keepSessionsWithDirectory(
      candidates,
      limit,
      input.sessionDirectoryExists ?? isExistingDirectory,
    )
  ).map((descriptor) =>
    toRecentProviderSessionDescriptorPayload(descriptor, {
      providerLabel: providerSnapshotManager.getProviderLabel(descriptor.provider),
    }),
  );

  return {
    entries,
    filteredAlreadyImportedCount,
    providerErrors: listing.providerErrors,
  };
}

function normalizeImportSessionQuery(query: string | undefined): string | null {
  const normalized = query?.trim().toLowerCase();
  return normalized ? normalized : null;
}

export async function importProviderSession(
  input: ImportProviderSessionInput,
): Promise<ImportProviderSessionResult> {
  const cwd = input.request.cwd;
  if (!cwd) {
    throw new Error("Import requires cwd from the selected provider session");
  }
  const key = await resolveProviderSessionImportMutationKey(input);
  return serializeProviderSessionImport(input.agentManager, key, async () => {
    const placement = await input.workspaceProvisioning.runInImportWorkspace(
      { cwd, requestedWorkspaceId: input.request.workspaceId },
      (workspace) => importProviderSessionNow(input, cwd, workspace.workspaceId),
    );
    return { ...placement.value, createdWorkspace: placement.createdWorkspace };
  });
}

async function importProviderSessionNow(
  input: ImportProviderSessionInput,
  cwd: string,
  workspaceId: string,
): Promise<ImportedProviderSession> {
  const { provider, providerHandleId, labels } = input.request;

  const matchingRecords = await input.agentStorage.listByProviderSession(
    provider,
    providerHandleId,
  );
  const activeRecord = matchingRecords.find((record) => !record.archivedAt);
  if (activeRecord) {
    throw new Error(`Provider session is already imported: ${providerHandleId}`);
  }
  const archivedRecord = matchingRecords.find((record) => record.archivedAt);
  if (archivedRecord?.persistence && archivedRecord.archivedAt) {
    if (!createRealpathAwarePathMatcher(cwd)(archivedRecord.cwd)) {
      throw new Error(`Provider session cwd does not match import cwd: ${providerHandleId}`);
    }
    const requestedParentAgentId = getParentAgentIdFromLabels(input.request.labels);
    const labelPatch: Record<string, string | null> = { ...input.request.labels };
    if (
      Object.hasOwn(archivedRecord.labels, PARENT_AGENT_ID_LABEL) ||
      Object.hasOwn(input.request.labels ?? {}, PARENT_AGENT_ID_LABEL)
    ) {
      labelPatch[PARENT_AGENT_ID_LABEL] = requestedParentAgentId;
    }
    await unarchiveAgentState(input.agentStorage, input.agentManager, archivedRecord.id, {
      workspaceId,
      labels: Object.keys(labelPatch).length > 0 ? labelPatch : undefined,
    });
    try {
      const snapshot = await ensureAgentLoaded(archivedRecord.id, {
        agentManager: input.agentManager,
        agentStorage: input.agentStorage,
        logger: input.logger,
      });
      return {
        snapshot,
        timelineSize: input.agentManager.getTimeline(snapshot.id).length,
      };
    } catch (error) {
      await rollbackArchivedImport(input, archivedRecord, archivedRecord.archivedAt);
      throw error;
    }
  }

  const snapshot = await input.agentManager.importProviderSession({
    provider,
    providerHandleId,
    cwd,
    workspaceId,
    labels,
  });
  await unarchiveAgentState(input.agentStorage, input.agentManager, snapshot.id);

  return {
    snapshot,
    timelineSize: input.agentManager.getTimeline(snapshot.id).length,
  };
}

async function serializeProviderSessionImport<T>(
  agentManager: ImportSessionAgentManager,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let mutations = providerSessionImportMutations.get(agentManager);
  if (!mutations) {
    mutations = new Map();
    providerSessionImportMutations.set(agentManager, mutations);
  }

  const previous = mutations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  mutations.set(key, next);
  try {
    return await next;
  } finally {
    if (mutations.get(key) === next) {
      mutations.delete(key);
    }
  }
}

async function resolveProviderSessionImportMutationKey(
  input: ImportProviderSessionInput,
): Promise<string> {
  const matchingRecord = (
    await input.agentStorage.listByProviderSession(
      input.request.provider,
      input.request.providerHandleId,
    )
  ).at(0);
  return matchingRecord
    ? `agent\0${matchingRecord.id}`
    : `handle\0${toProviderSessionHandleKey(
        input.request.provider,
        input.request.providerHandleId,
      )}`;
}

async function rollbackArchivedImport(
  input: ImportProviderSessionInput,
  archivedRecord: StoredAgentRecord,
  archivedAt: string,
): Promise<void> {
  try {
    if (input.agentManager.getAgent(archivedRecord.id)) {
      await input.agentManager.closeAgent(archivedRecord.id);
    }
    await input.agentManager.archiveSnapshot(archivedRecord.id, archivedAt);
  } catch (error) {
    input.logger.error(
      { err: error, agentId: archivedRecord.id },
      "Failed to re-archive provider session after import failure",
    );
  }

  try {
    await input.agentStorage.upsert(archivedRecord);
  } catch (error) {
    input.logger.error(
      { err: error, agentId: archivedRecord.id },
      "Failed to restore archived agent record after import failure",
    );
  }
}

function parseRecentProviderSessionsSince(since: string | undefined): number | null {
  if (!since) {
    return null;
  }
  const timestamp = Date.parse(since);
  if (Number.isNaN(timestamp)) {
    throw new ImportSessionsRequestError("invalid_since", "Invalid recent provider sessions since");
  }
  return timestamp;
}

/**
 * The first `limit` sessions, in order, whose directory is still there. A session started in a
 * directory since deleted (a throwaway worktree) can't be imported: the import fails on it.
 */
async function isExistingDirectory(cwd: string): Promise<boolean> {
  return stat(cwd).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

async function keepSessionsWithDirectory<T extends { cwd: string; importedAgentId?: string }>(
  sessions: T[],
  limit: number,
  directoryExists: (cwd: string) => Promise<boolean>,
): Promise<T[]> {
  const kept: T[] = [];
  for (let start = 0; start < sessions.length && kept.length < limit; start += limit) {
    const batch = sessions.slice(start, start + limit);
    const present = await Promise.all(
      batch.map((session) => (session.importedAgentId ? true : directoryExists(session.cwd))),
    );
    for (let index = 0; index < batch.length && kept.length < limit; index++) {
      if (present[index]) kept.push(batch[index]!);
    }
  }
  return kept;
}

async function collectImportedProviderSessions(
  agentManager: Pick<AgentManager, "listAgents">,
  agentStorage: Pick<AgentStorage, "listAll">,
  providerFilter: Set<string> | undefined,
): Promise<{ handles: Map<string, string>; count: number }> {
  const handles = new Map<string, string>();
  const sessions = new Set<string>();
  // Explicit provider-history import deduplicates against archived as well as active sessions.
  const records = await agentStorage.listAll();
  const storedRecordsById = new Map(records.map((record) => [record.id, record]));

  const collect = (
    agentId: string,
    provider: AgentProvider | StoredAgentRecord["provider"] | string,
    persistence: AgentPersistenceHandle | null | undefined,
  ) => {
    if (!persistence || (providerFilter && !providerFilter.has(provider))) return;
    sessions.add(toProviderSessionHandleKey(provider, persistence.sessionId));
    collectProviderSessionHandleKeys(handles, agentId, provider, persistence);
  };

  for (const agent of agentManager.listAgents()) {
    if (storedRecordsById.get(agent.id)?.archivedAt) {
      continue;
    }
    collect(agent.id, agent.provider, agent.persistence);
  }

  for (const record of records) {
    if (record.archivedAt) {
      continue;
    }
    collect(record.id, record.provider, record.persistence);
  }

  return { handles, count: sessions.size };
}

function toProviderSessionHandleKey(provider: string, providerHandleId: string): string {
  return `${provider}\0${providerHandleId}`;
}

export function isMetadataGenerationSession(input: { firstPromptPreview: string | null }): boolean {
  return (
    input.firstPromptPreview?.trimStart().startsWith(METADATA_GENERATION_PROMPT_PREFIX) ?? false
  );
}

function collectProviderSessionHandleKeys(
  target: Map<string, string>,
  agentId: string,
  provider: AgentProvider | StoredAgentRecord["provider"] | string,
  persistence: AgentPersistenceHandle | null | undefined,
): void {
  if (!persistence) {
    return;
  }

  // A live agent is collected before its stored record, and keeps its handle.
  const keys = [toProviderSessionHandleKey(provider, persistence.sessionId)];
  if (persistence.nativeHandle) {
    keys.push(toProviderSessionHandleKey(provider, persistence.nativeHandle));
  }
  for (const key of keys) {
    if (!target.has(key)) target.set(key, agentId);
  }
}
