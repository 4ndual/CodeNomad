import path from "path"
import type { FileSystemEntry } from "../api-types"

export const WORKSPACE_CANDIDATE_CACHE_TTL_MS = 30_000
export const WORKSPACE_CANDIDATE_CACHE_MAX_ENTRIES = 16
export const WORKSPACE_CANDIDATE_CACHE_MAX_CANDIDATES = 32_000

interface WorkspaceCandidateCacheEntry {
  scope: string
  expiresAt: number
  candidates: FileSystemEntry[]
}

const workspaceCandidateCache = new Map<string, WorkspaceCandidateCacheEntry>()

export function getWorkspaceCandidates(rootDir: string, scope: string, now = Date.now()): FileSystemEntry[] | undefined {
  const key = normalizeKey(rootDir)
  const cached = workspaceCandidateCache.get(key)
  if (!cached || cached.scope !== scope) {
    return undefined
  }

  if (cached.expiresAt <= now) {
    workspaceCandidateCache.delete(key)
    return undefined
  }

  workspaceCandidateCache.delete(key)
  workspaceCandidateCache.set(key, cached)
  return cloneEntries(cached.candidates)
}

export function refreshWorkspaceCandidates(
  rootDir: string,
  scope: string,
  builder: () => FileSystemEntry[],
  now = Date.now(),
): FileSystemEntry[] {
  const key = normalizeKey(rootDir)
  const freshCandidates = builder()

  const storedCandidates = cloneEntries(freshCandidates)
  sweepExpiredEntries(now)
  workspaceCandidateCache.delete(key)
  workspaceCandidateCache.set(key, {
    scope,
    expiresAt: now + WORKSPACE_CANDIDATE_CACHE_TTL_MS,
    candidates: storedCandidates,
  })
  enforceCacheBounds()

  return cloneEntries(storedCandidates)
}

export function clearWorkspaceSearchCache(rootDir?: string) {
  if (typeof rootDir === "undefined") {
    workspaceCandidateCache.clear()
    return
  }

  workspaceCandidateCache.delete(normalizeKey(rootDir))
}

function cloneEntries(entries: FileSystemEntry[]): FileSystemEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

function sweepExpiredEntries(now: number) {
  for (const [key, entry] of workspaceCandidateCache) {
    if (entry.expiresAt <= now) {
      workspaceCandidateCache.delete(key)
    }
  }
}

function enforceCacheBounds() {
  let candidateCount = 0
  for (const entry of workspaceCandidateCache.values()) {
    candidateCount += entry.candidates.length
  }

  while (
    workspaceCandidateCache.size > WORKSPACE_CANDIDATE_CACHE_MAX_ENTRIES ||
    candidateCount > WORKSPACE_CANDIDATE_CACHE_MAX_CANDIDATES
  ) {
    const oldest = workspaceCandidateCache.entries().next().value as
      | [string, WorkspaceCandidateCacheEntry]
      | undefined
    if (!oldest) {
      return
    }
    workspaceCandidateCache.delete(oldest[0])
    candidateCount -= oldest[1].candidates.length
  }
}

function normalizeKey(rootDir: string) {
  return path.resolve(rootDir)
}
