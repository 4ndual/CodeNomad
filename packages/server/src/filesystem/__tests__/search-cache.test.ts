import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"
import type { FileSystemEntry } from "../../api-types"
import {
  clearWorkspaceSearchCache,
  getWorkspaceCandidates,
  refreshWorkspaceCandidates,
  WORKSPACE_CANDIDATE_CACHE_MAX_CANDIDATES,
  WORKSPACE_CANDIDATE_CACHE_MAX_ENTRIES,
  WORKSPACE_CANDIDATE_CACHE_TTL_MS,
} from "../search-cache"

describe("workspace search cache", () => {
  beforeEach(() => {
    clearWorkspaceSearchCache()
  })

  it("expires cached candidates after the TTL", () => {
    const workspacePath = "/tmp/workspace"
    const startTime = 1_000

    refreshWorkspaceCandidates(workspacePath, "query-a", () => [createEntry("file-a")], startTime)

    const beforeExpiry = getWorkspaceCandidates(
      workspacePath,
      "query-a",
      startTime + WORKSPACE_CANDIDATE_CACHE_TTL_MS - 1,
    )
    assert.ok(beforeExpiry)
    assert.equal(beforeExpiry.length, 1)
    assert.equal(beforeExpiry[0].name, "file-a")

    const afterExpiry = getWorkspaceCandidates(
      workspacePath,
      "query-a",
      startTime + WORKSPACE_CANDIDATE_CACHE_TTL_MS + 1,
    )
    assert.equal(afterExpiry, undefined)
  })

  it("sweeps expired entries before enforcing the entry bound", () => {
    const startTime = 1_000
    refreshWorkspaceCandidates("/tmp/expired", "query", () => [createEntry("expired")], startTime)

    const freshTime = startTime + WORKSPACE_CANDIDATE_CACHE_TTL_MS + 1
    for (let index = 0; index < WORKSPACE_CANDIDATE_CACHE_MAX_ENTRIES; index += 1) {
      refreshWorkspaceCandidates(`/tmp/fresh-${index}`, "query", () => [createEntry(`fresh-${index}`)], freshTime)
    }

    assert.equal(getWorkspaceCandidates("/tmp/expired", "query", freshTime), undefined)
    assert.equal(getWorkspaceCandidates("/tmp/fresh-0", "query", freshTime)?.[0].name, "fresh-0")
  })

  it("evicts the least recently used entry at the entry bound", () => {
    const now = 5_000
    for (let index = 0; index < WORKSPACE_CANDIDATE_CACHE_MAX_ENTRIES; index += 1) {
      refreshWorkspaceCandidates(`/tmp/workspace-${index}`, "query", () => [createEntry(`file-${index}`)], now)
    }

    assert.ok(getWorkspaceCandidates("/tmp/workspace-0", "query", now + 1))
    refreshWorkspaceCandidates("/tmp/workspace-new", "query", () => [createEntry("file-new")], now + 1)

    assert.equal(getWorkspaceCandidates("/tmp/workspace-1", "query", now + 2), undefined)
    assert.equal(getWorkspaceCandidates("/tmp/workspace-0", "query", now + 2)?.[0].name, "file-0")
    assert.equal(getWorkspaceCandidates("/tmp/workspace-new", "query", now + 2)?.[0].name, "file-new")
  })

  it("evicts least recently used entries when the candidate bound is exceeded", () => {
    const candidatesPerEntry = WORKSPACE_CANDIDATE_CACHE_MAX_CANDIDATES / 4
    const now = 8_000
    for (let index = 0; index < 4; index += 1) {
      refreshWorkspaceCandidates(
        `/tmp/large-${index}`,
        "query",
        () => Array.from({ length: candidatesPerEntry }, (_, candidateIndex) => createEntry(`${index}-${candidateIndex}`)),
        now,
      )
    }

    assert.ok(getWorkspaceCandidates("/tmp/large-0", "query", now + 1))
    refreshWorkspaceCandidates(
      "/tmp/large-new",
      "query",
      () => Array.from({ length: candidatesPerEntry }, (_, index) => createEntry(`new-${index}`)),
      now + 1,
    )

    assert.equal(getWorkspaceCandidates("/tmp/large-1", "query", now + 2), undefined)
    assert.equal(getWorkspaceCandidates("/tmp/large-0", "query", now + 2)?.length, candidatesPerEntry)
  })

  it("replaces cached entries when manually refreshed", () => {
    const workspacePath = "/tmp/workspace"

    refreshWorkspaceCandidates(workspacePath, "query-a", () => [createEntry("file-a")], 5_000)
    const initial = getWorkspaceCandidates(workspacePath, "query-a", 5_001)
    assert.ok(initial)
    assert.equal(initial[0].name, "file-a")

    refreshWorkspaceCandidates(workspacePath, "query-a", () => [createEntry("file-b")], 6_000)
    const refreshed = getWorkspaceCandidates(workspacePath, "query-a", 6_001)
    assert.ok(refreshed)
    assert.equal(refreshed[0].name, "file-b")
  })

  it("does not reuse candidates across query scopes", () => {
    const workspacePath = "/tmp/workspace"

    refreshWorkspaceCandidates(workspacePath, "query-a", () => [createEntry("file-a")], 5_000)
    assert.equal(getWorkspaceCandidates(workspacePath, "query-a", 5_001)?.[0].name, "file-a")
    assert.equal(getWorkspaceCandidates(workspacePath, "query-b", 5_001), undefined)

    refreshWorkspaceCandidates(workspacePath, "query-b", () => [createEntry("file-b")], 5_000)
    assert.equal(getWorkspaceCandidates(workspacePath, "query-a", 5_001), undefined)
    assert.equal(getWorkspaceCandidates(workspacePath, "query-b", 5_001)?.[0].name, "file-b")

    clearWorkspaceSearchCache(workspacePath)
    assert.equal(getWorkspaceCandidates(workspacePath, "query-a", 5_001), undefined)
    assert.equal(getWorkspaceCandidates(workspacePath, "query-b", 5_001), undefined)
  })
})

function createEntry(name: string): FileSystemEntry {
  return {
    name,
    path: name,
    absolutePath: `/tmp/${name}`,
    type: "file",
    size: 1,
    modifiedAt: new Date().toISOString(),
  }
}
