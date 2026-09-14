import { isSessionNotFoundError, type OpenCodeEvent } from "@opencode-ai/client"
import { EventBus } from "../events/bus"
import { Logger } from "../logger"
import { WorkspaceManager } from "./manager"
import { InstanceStreamStatus } from "../api-types"

const RECONNECT_DELAY_MS = 1000
const DIRECTORY_OWNER_CACHE_MS = 2000
const SESSION_DIRECTORY_CACHE_MS = 2000
export const DIRECTORY_OWNER_CACHE_MAX_ENTRIES = 512
export const SESSION_DIRECTORY_CACHE_MAX_ENTRIES = 2_048
export const PTY_DIRECTORY_CACHE_MAX_ENTRIES = 512
export const SHELL_DIRECTORY_CACHE_MAX_ENTRIES = 512
const GLOBAL_EVENT_TYPES = new Set([
  "agent.updated",
  "catalog.updated",
  "command.updated",
  "config.updated",
  "credential.switched",
  "credential.updated",
  "integration.connection.updated",
  "integration.updated",
  "installation.update-available",
  "installation.updated",
  "mcp.resources.changed",
  "mcp.status.changed",
  "models-dev.refreshed",
  "server.connected",
])

interface InstanceEventBridgeOptions {
  workspaceManager: WorkspaceManager
  eventBus: EventBus
  logger: Logger
}

export class InstanceEventBridge {
  private readonly controller = new AbortController()
  private status: InstanceStreamStatus = "connecting"
  private generation = 0
  private task?: Promise<void>
  private readonly directoryOwners = new Map<string, { expiresAt: number; owners: Promise<string[]> }>()
  private readonly sessionDirectories = new Map<string, { expiresAt: number; directory: Promise<string | undefined> }>()
  private readonly ptyDirectories = new Map<string, string>()
  private readonly shellDirectories = new Map<string, string>()
  private readonly onWorkspaceStarted = (event: { workspace: { id: string } }) => {
    this.clearLocationCaches()
    if (!this.task) this.task = this.run()
    else this.publishStatus(event.workspace.id, this.status)
  }
  private readonly onWorkspaceStopped = (event: { workspaceId: string }) => {
    this.clearLocationCaches()
    this.publishStatus(event.workspaceId, "disconnected", "workspace stopped")
  }
  private readonly onWorkspaceError = (event: { workspace: { id: string } }) => {
    this.clearLocationCaches()
    this.publishStatus(event.workspace.id, "disconnected", "workspace error")
  }

  constructor(private readonly options: InstanceEventBridgeOptions) {
    const bus = this.options.eventBus
    bus.on("workspace.started", this.onWorkspaceStarted)
    bus.on("workspace.stopped", this.onWorkspaceStopped)
    bus.on("workspace.error", this.onWorkspaceError)
  }

  shutdown() {
    this.controller.abort()
    const bus = this.options.eventBus
    bus.off("workspace.started", this.onWorkspaceStarted)
    bus.off("workspace.stopped", this.onWorkspaceStopped)
    bus.off("workspace.error", this.onWorkspaceError)
    for (const workspace of this.options.workspaceManager.list()) {
      this.publishStatus(workspace.id, "disconnected")
    }
  }

  private async run() {
    while (!this.controller.signal.aborted) {
      this.generation += 1
      this.clearLocationCaches()
      this.updateStatus("connecting")
      try {
        const events = await this.options.workspaceManager.subscribeToSharedService(this.controller.signal)
        let confirmed = false
        for await (const event of events) {
          if (this.controller.signal.aborted) return
          if (!confirmed) {
            if (event.type !== "server.connected") {
              throw new Error(`Shared OpenCode event stream started with ${event.type}, expected server.connected`)
            }
            confirmed = true
            this.updateStatus("connected")
          }
          await this.publishEvent(event)
        }
        if (!this.controller.signal.aborted) throw new Error("Shared OpenCode event stream ended")
      } catch (error) {
        if (this.controller.signal.aborted) return
        this.options.logger.warn({ err: error }, "Shared OpenCode event stream disconnected")
        this.updateStatus("error", error instanceof Error ? error.message : String(error))
        await this.delay(RECONNECT_DELAY_MS)
      }
    }
  }

  private async publishEvent(event: OpenCodeEvent) {
    const sessionId = this.sessionId(event)
    const ptyId = this.ptyId(event)
    const shellId = this.shellId(event)
    if (event.type === "session.moved" && sessionId) this.sessionDirectories.delete(sessionId)

    const directory = event.location?.directory
      ?? this.ptyInfoDirectory(event)
      ?? (ptyId ? this.ptyDirectories.get(ptyId) : undefined)
      ?? this.shellInfoDirectory(event)
      ?? (shellId ? this.shellDirectories.get(shellId) : undefined)
      ?? (sessionId ? await this.resolveSessionDirectory(sessionId) : undefined)
    if (!directory) {
      if (GLOBAL_EVENT_TYPES.has(event.type)) {
        this.broadcastEvent(event)
        return
      }
      if (event.type === "session.deleted" && sessionId) {
        // Deletion can make session.get return 404 before the event arrives. Session IDs are
        // service-global, so notifying every logical workspace cannot delete another session.
        this.broadcastEvent(event)
        this.sessionDirectories.delete(sessionId)
      }
      return
    }
    if (sessionId) {
      this.setBounded(this.sessionDirectories, sessionId, {
        expiresAt: Date.now() + SESSION_DIRECTORY_CACHE_MS,
        directory: Promise.resolve(directory),
      }, SESSION_DIRECTORY_CACHE_MAX_ENTRIES)
    }
    if (ptyId) this.setBounded(this.ptyDirectories, ptyId, directory, PTY_DIRECTORY_CACHE_MAX_ENTRIES)
    if (shellId) this.setBounded(this.shellDirectories, shellId, directory, SHELL_DIRECTORY_CACHE_MAX_ENTRIES)

    const instanceIds = await this.resolveDirectoryOwners(directory)
    if (instanceIds.length === 0) {
      if (event.type === "session.deleted" && sessionId) this.sessionDirectories.delete(sessionId)
      if (event.type === "pty.deleted" && ptyId) this.ptyDirectories.delete(ptyId)
      if (event.type === "shell.deleted" && shellId) this.shellDirectories.delete(shellId)
      return
    }

    for (const instanceId of instanceIds) {
      this.options.eventBus.publish({ type: "instance.event", instanceId, event })
    }
    if (event.type === "session.deleted" && sessionId) this.sessionDirectories.delete(sessionId)
    if (event.type === "pty.deleted" && ptyId) this.ptyDirectories.delete(ptyId)
    if (event.type === "shell.deleted" && shellId) this.shellDirectories.delete(shellId)
  }

  private sessionId(event: OpenCodeEvent): string | undefined {
    const data = event.data as { sessionID?: unknown; form?: { sessionID?: unknown } }
    const sessionId = data.sessionID ?? (event.type === "form.created" ? data.form?.sessionID : undefined)
    return typeof sessionId === "string" && sessionId ? sessionId : undefined
  }

  private ptyId(event: OpenCodeEvent): string | undefined {
    if (!event.type.startsWith("pty.")) return undefined
    const data = event.data as { id?: unknown; info?: { id?: unknown } }
    const id = data.id ?? data.info?.id
    return typeof id === "string" && id ? id : undefined
  }

  private ptyInfoDirectory(event: OpenCodeEvent): string | undefined {
    if (event.type !== "pty.created" && event.type !== "pty.updated") return undefined
    const cwd = (event.data as { info?: { cwd?: unknown } }).info?.cwd
    return typeof cwd === "string" && cwd ? cwd : undefined
  }

  private shellId(event: OpenCodeEvent): string | undefined {
    if (!event.type.startsWith("shell.")) return undefined
    const data = event.data as { id?: unknown; info?: { id?: unknown } }
    const id = data.id ?? data.info?.id
    return typeof id === "string" && id ? id : undefined
  }

  private shellInfoDirectory(event: OpenCodeEvent): string | undefined {
    if (event.type !== "shell.created") return undefined
    const cwd = (event.data as { info?: { cwd?: unknown } }).info?.cwd
    return typeof cwd === "string" && cwd ? cwd : undefined
  }

  private broadcastEvent(event: OpenCodeEvent): void {
    for (const workspace of this.options.workspaceManager.list()) {
      this.options.eventBus.publish({ type: "instance.event", instanceId: workspace.id, event })
    }
  }

  private resolveSessionDirectory(sessionId: string): Promise<string | undefined> {
    const now = Date.now()
    const cached = this.sessionDirectories.get(sessionId)
    if (cached && cached.expiresAt > now) {
      this.touch(this.sessionDirectories, sessionId, cached)
      return cached.directory
    }
    if (cached) this.sessionDirectories.delete(sessionId)

    const resolve = () => this.options.workspaceManager.getSharedServiceClient()
      .then((client) => client.session.get({ sessionID: sessionId }))
      .then((session) => session.location.directory)
    const directory = resolve().catch((error) => {
      if (isSessionNotFoundError(error)) return undefined
      return resolve().catch((retryError) => {
        this.options.logger.warn({ err: retryError, sessionId }, "Failed to resolve instance event session location")
        return undefined
      })
    })
    const entry = { expiresAt: Number.POSITIVE_INFINITY, directory }
    this.setBounded(this.sessionDirectories, sessionId, entry, SESSION_DIRECTORY_CACHE_MAX_ENTRIES)
    const settle = () => { entry.expiresAt = Date.now() + SESSION_DIRECTORY_CACHE_MS }
    void directory.then(settle, settle)
    return directory
  }

  private resolveDirectoryOwners(directory: string): Promise<string[]> {
    const now = Date.now()
    const cached = this.directoryOwners.get(directory)
    if (cached && cached.expiresAt > now) {
      this.touch(this.directoryOwners, directory, cached)
      return cached.owners
    }
    if (cached) this.directoryOwners.delete(directory)

    const workspaces = this.options.workspaceManager.list()
    const owners = Promise.allSettled(workspaces.map((workspace) => (
      this.options.workspaceManager.ownsDirectory(workspace.id, directory)
    )))
      .then(async (ownership) => {
        if (ownership.some((result) => result.status === "rejected")) {
          ownership = await Promise.allSettled(ownership.map((result, index) => (
            result.status === "fulfilled"
              ? Promise.resolve(result.value)
              : this.options.workspaceManager.ownsDirectory(workspaces[index].id, directory)
          )))
        }
        const failed = ownership.find((result) => result.status === "rejected")
        if (failed) {
          this.options.logger.warn({ err: failed.reason, directory }, "Failed to resolve instance event directory owner")
        }
        const currentIds = new Set(this.options.workspaceManager.list().map((workspace) => workspace.id))
        return ownership.flatMap((result, index) => {
          const id = workspaces[index].id
          return result.status === "fulfilled" && result.value && currentIds.has(id) ? [id] : []
        })
      })
    const entry = { expiresAt: Number.POSITIVE_INFINITY, owners }
    this.setBounded(this.directoryOwners, directory, entry, DIRECTORY_OWNER_CACHE_MAX_ENTRIES)
    const settle = () => { entry.expiresAt = Date.now() + DIRECTORY_OWNER_CACHE_MS }
    void owners.then(settle, settle)
    return owners
  }

  private clearLocationCaches(): void {
    this.directoryOwners.clear()
    this.sessionDirectories.clear()
    this.ptyDirectories.clear()
    this.shellDirectories.clear()
  }

  private touch<K, V>(cache: Map<K, V>, key: K, value: V): void {
    cache.delete(key)
    cache.set(key, value)
  }

  private setBounded<K, V>(cache: Map<K, V>, key: K, value: V, maxEntries: number): void {
    this.touch(cache, key, value)
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value as K | undefined
      if (oldest === undefined) return
      cache.delete(oldest)
    }
  }

  private updateStatus(status: InstanceStreamStatus, reason?: string) {
    this.status = status
    for (const workspace of this.options.workspaceManager.list()) {
      this.publishStatus(workspace.id, status, reason)
    }
  }

  private publishStatus(instanceId: string, status: InstanceStreamStatus, reason?: string) {
    this.options.logger.debug({ instanceId, status, reason }, "Instance event status updated")
    this.options.eventBus.publish({ type: "instance.eventStatus", instanceId, status, generation: this.generation, reason })
  }

  private delay(duration: number) {
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, duration)
      this.controller.signal.addEventListener("abort", () => {
        clearTimeout(timeout)
        resolve()
      }, { once: true })
    })
  }
}
