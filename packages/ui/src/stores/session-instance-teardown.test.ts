import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import type { Instance } from "../types/instance.ts"
import type { Session } from "../types/session.ts"
import { addInstance, removeInstance } from "./instances.ts"
import {
  activeParentSessionId,
  activeSessionId,
  agents,
  beginSessionGenerationAdmission,
  beginSessionSearch,
  clearInstanceSessionState,
  expandedSessions,
  getSessionDraftPrompt,
  getSessionListError,
  getSessionListScope,
  loading,
  messagesLoaded,
  providers,
  sessionInfoByInstance,
  sessionPagination,
  sessionSearch,
  sessions,
  setActiveParentSession,
  setAgents,
  setLoading,
  setMessagesLoaded,
  setProviders,
  setSessionDraftPrompt,
  setSessionExpanded,
  setSessionInfoByInstance,
  setSessionListError,
  setSessionListScope,
  setSessionPage,
  setSessions,
  threadTotalsByInstance,
  updateThreadTotalsForParent,
} from "./session-state.ts"

const instanceId = "session-teardown"

function session(id = "session"): Session {
  return {
    id, instanceId, parentId: null, title: id, agent: "build", status: "idle",
    model: { providerId: "provider", modelId: "model" },
    location: { directory: "/workspace" }, time: { created: 1, updated: 1 },
  } as Session
}

function instance(): Instance {
  return {
    id: instanceId, folder: "/workspace", port: 0, pid: 0, proxyPath: "",
    status: "ready", client: {} as Instance["client"],
  }
}

function seedSessionBuckets(): void {
  const seeded = session()
  setSessions((previous) => new Map(previous).set(instanceId, new Map([[seeded.id, seeded]])))
  setAgents((previous) => new Map(previous).set(instanceId, []))
  setProviders((previous) => new Map(previous).set(instanceId, []))
  setMessagesLoaded((previous) => new Map(previous).set(instanceId, new Set([seeded.id])))
  setSessionInfoByInstance((previous) => new Map(previous).set(instanceId, new Map([[seeded.id, {
    cost: 1, contextWindow: 1, isSubscriptionModel: false, inputTokens: 1,
    outputTokens: 1, reasoningTokens: 0, actualUsageTokens: 2,
    modelOutputLimit: 1, contextAvailableTokens: 0,
  }]])))
  updateThreadTotalsForParent(instanceId, seeded.id)
  setSessionPage(instanceId, [seeded.id], true, true, "cursor")
  beginSessionSearch(instanceId, "query")
  setSessionListScope(instanceId, "current")
  setSessionListError(instanceId, "failed")
  setSessionDraftPrompt(instanceId, seeded.id, "draft")
  setSessionExpanded(instanceId, seeded.id, true)
  setActiveParentSession(instanceId, seeded.id)
  setLoading((previous) => ({
    fetchingSessions: new Map(previous.fetchingSessions).set(instanceId, true),
    creatingSession: new Map(previous.creatingSession).set(instanceId, true),
    deletingSession: new Map(previous.deletingSession).set(instanceId, new Set([seeded.id])),
    loadingMessages: new Map(previous.loadingMessages).set(instanceId, new Set([seeded.id])),
  }))
}

function assertInstanceBucketsCleared(): void {
  assert.equal(sessions().has(instanceId), false)
  assert.equal(agents().has(instanceId), false)
  assert.equal(providers().has(instanceId), false)
  assert.equal(messagesLoaded().has(instanceId), false)
  assert.equal(sessionInfoByInstance().has(instanceId), false)
  assert.equal(threadTotalsByInstance().has(instanceId), false)
  assert.equal(sessionPagination().has(instanceId), false)
  assert.equal(sessionSearch().has(instanceId), false)
  assert.equal(activeSessionId().has(instanceId), false)
  assert.equal(activeParentSessionId().has(instanceId), false)
  assert.equal(expandedSessions().has(instanceId), false)
  assert.equal(getSessionDraftPrompt(instanceId, "session"), "")
  assert.equal(getSessionListError(instanceId), undefined)
  assert.equal(getSessionListScope(instanceId), "all")
  assert.equal(loading().fetchingSessions.has(instanceId), false)
  assert.equal(loading().creatingSession.has(instanceId), false)
  assert.equal(loading().deletingSession.has(instanceId), false)
  assert.equal(loading().loadingMessages.has(instanceId), false)
}

afterEach(() => {
  clearInstanceSessionState(instanceId)
  removeInstance(instanceId, { authoritative: false })
})

describe("instance session-state teardown", () => {
  it("clears every instance-keyed metadata, catalog, and pagination bucket", () => {
    seedSessionBuckets()
    clearInstanceSessionState(instanceId)
    assertInstanceBucketsCleared()
  })

  it("removeInstance stays bounded across repeated remove and id-reuse churn", () => {
    for (let cycle = 0; cycle < 25; cycle += 1) {
      addInstance(instance())
      seedSessionBuckets()
      removeInstance(instanceId, { authoritative: false })
      assertInstanceBucketsCleared()
    }
  })

  it("cancels old generation admissions before an instance id is reused", () => {
    seedSessionBuckets()
    const admission = beginSessionGenerationAdmission(instanceId, "session")
    clearInstanceSessionState(instanceId)
    const replacement = session("session")
    setSessions(new Map([[instanceId, new Map([[replacement.id, replacement]])]]))

    admission.complete()

    assert.equal(sessions().get(instanceId)?.get("session")?.generationAdmissionToken, undefined)
  })
})
