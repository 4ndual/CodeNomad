import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import pino from "pino"

import { EventBus } from "../events/bus"
import { WorkspaceManager } from "./manager"
import { WorkspaceMetadataStore } from "./metadata-store"

function createManager(rootDir: string, registryPath: string, counters = { activations: 0 }) {
  const sharedService = {
    endpoint: async () => ({ url: "http://127.0.0.1:4321" }),
    client: async () => ({}),
    headers: async () => {
      counters.activations += 1
      return undefined
    },
    validateLocation: async () => { throw new Error("unexpected runtime activation") },
    evictLocation: async () => undefined,
    subscribe: async () => ({ async *[Symbol.asyncIterator]() {} }),
    shutdown: async () => undefined,
  }
  return new WorkspaceManager({
    rootDir,
    settings: { getOwner: () => ({ environmentVariables: {} }) } as never,
    binaryResolver: { resolveDefault: () => ({ path: process.execPath, label: "OpenCode V2", version: "test" }) } as never,
    eventBus: new EventBus(),
    logger: pino({ level: "silent" }),
    sharedService: sharedService as never,
    metadataStore: new WorkspaceMetadataStore(registryPath),
  })
}

describe("workspace metadata persistence", () => {
  it("restores IDs, names, and metadata lazily after a clean shutdown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-persistence-"))
    const registryPath = path.join(root, "config", "workspaces.json")
    const workspacePath = path.join(root, "project")
    try {
      const first = createManager(root, registryPath)
      const created = await first.create(workspacePath, "Preserved name")
      await first.shutdown()

      const counters = { activations: 0 }
      const restarted = createManager(root, registryPath, counters)
      await restarted.restore()
      const restored = restarted.list()

      assert.equal(counters.activations, 0)
      assert.equal(restored.length, 1)
      const { requestId: _requestId, ...persistedCreated } = created.workspace
      assert.deepEqual(restored[0], {
        ...persistedCreated,
        status: "stopped",
      })
      await restarted.shutdown()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("skips missing, non-directory, and outside-root persisted paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-stale-persistence-"))
    const outside = await mkdtemp(path.join(os.tmpdir(), "codenomad-outside-"))
    const registryPath = path.join(root, "config", "workspaces.json")
    const valid = path.join(root, "valid")
    const file = path.join(root, "not-a-directory")
    await mkdir(valid)
    await mkdir(path.dirname(registryPath), { recursive: true })
    await writeFile(file, "file")
    const metadata = (id: string, workspacePath: string) => ({
      id,
      path: workspacePath,
      proxyPath: `/workspaces/${id}/instance`,
      binaryId: process.execPath,
      binaryLabel: "OpenCode V2",
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    })
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      workspaces: [
        metadata("valid", valid),
        metadata("missing", path.join(root, "missing")),
        metadata("file", file),
        metadata("outside", outside),
      ],
    }))

    try {
      const manager = createManager(root, registryPath)
      await manager.restore()
      assert.deepEqual(manager.list().map(({ id }) => id), ["valid"])
      await manager.shutdown()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it("atomically updates the registry when a workspace is deleted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-delete-persistence-"))
    const registryPath = path.join(root, "config", "workspaces.json")
    try {
      const manager = createManager(root, registryPath)
      const created = await manager.create(path.join(root, "project"))
      await manager.delete(created.workspace.id)

      const registry = JSON.parse(await readFile(registryPath, "utf8"))
      assert.deepEqual(registry, { version: 1, workspaces: [] })
      await manager.shutdown()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
