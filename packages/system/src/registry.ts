import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export interface AgentEntry {
  user: string;
  group: string;
  mcpServer: McpServer;
  lowLevelServer: Server;
  sessionId: string;
  connectedAt: Date;
}

export class AgentRegistry {
  private byGroupUser = new Map<string, Map<string, AgentEntry>>();
  private bySessionId = new Map<string, AgentEntry>();

  register(entry: AgentEntry): void {
    // Evict any stale entry for the same user/group
    const existing = this.byGroupUser.get(entry.group)?.get(entry.user);
    if (existing) {
      this.bySessionId.delete(existing.sessionId);
    }

    if (!this.byGroupUser.has(entry.group)) {
      this.byGroupUser.set(entry.group, new Map());
    }
    this.byGroupUser.get(entry.group)!.set(entry.user, entry);
    this.bySessionId.set(entry.sessionId, entry);
  }

  unregister(sessionId: string): void {
    const entry = this.bySessionId.get(sessionId);
    if (!entry) return;
    this.bySessionId.delete(sessionId);
    this.byGroupUser.get(entry.group)?.delete(entry.user);
    if (this.byGroupUser.get(entry.group)?.size === 0) {
      this.byGroupUser.delete(entry.group);
    }
  }

  findAgent(toUser: string, toGroup: string): AgentEntry | undefined {
    return this.byGroupUser.get(toGroup)?.get(toUser);
  }

  listUsersInGroup(group: string): AgentEntry[] {
    const groupMap = this.byGroupUser.get(group);
    if (!groupMap) return [];
    return Array.from(groupMap.values());
  }

  listAllGroups(): string[] {
    return Array.from(this.byGroupUser.keys());
  }

  getBySessionId(sessionId: string): AgentEntry | undefined {
    return this.bySessionId.get(sessionId);
  }
}
