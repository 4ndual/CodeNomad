import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export interface PersistedWorkspaceMetadata {
  id: string
  path: string
  name?: string
  proxyPath: string
  binaryId: string
  binaryLabel: string
  binaryVersion?: string
  createdAt: string
  updatedAt: string
}

interface PersistedWorkspaceRegistry {
  version: 1
  workspaces: PersistedWorkspaceMetadata[]
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string"
}

function isWorkspaceMetadata(value: unknown): value is PersistedWorkspaceMetadata {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return typeof item.id === "string"
    && typeof item.path === "string"
    && optionalString(item.name)
    && typeof item.proxyPath === "string"
    && typeof item.binaryId === "string"
    && typeof item.binaryLabel === "string"
    && optionalString(item.binaryVersion)
    && typeof item.createdAt === "string"
    && typeof item.updatedAt === "string"
}

export class WorkspaceMetadataStore {
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async read(): Promise<PersistedWorkspaceMetadata[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"))
      if (!parsed || typeof parsed !== "object") throw new Error("workspace registry must be an object")
      const registry = parsed as Partial<PersistedWorkspaceRegistry>
      if (registry.version !== 1 || !Array.isArray(registry.workspaces)) {
        throw new Error("unsupported workspace registry format")
      }
      return registry.workspaces.filter(isWorkspaceMetadata)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
  }

  write(workspaces: PersistedWorkspaceMetadata[]): Promise<void> {
    const snapshot: PersistedWorkspaceRegistry = { version: 1, workspaces }
    const operation = this.writes.then(() => this.writeAtomic(snapshot))
    this.writes = operation.catch(() => undefined)
    return operation
  }

  private async writeAtomic(registry: PersistedWorkspaceRegistry): Promise<void> {
    const directory = path.dirname(this.filePath)
    const temporaryPath = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`)
    await mkdir(directory, { recursive: true })
    try {
      await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
      await rename(temporaryPath, this.filePath)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}
