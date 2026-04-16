import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentRegistry } from './registry.js';
import type { NatsBridge } from './nats-bridge.js';

export function registerTools(
  server: McpServer,
  registry: AgentRegistry,
  natsBridge: NatsBridge,
  callerSessionId: string
): void {

  server.registerTool('send_message', {
    description: 'Send a message to another agent. Fails immediately if recipient is not online.',
    inputSchema: {
      to_user: z.string().describe('Username of the recipient'),
      payload: z.unknown().describe('Arbitrary message payload'),
      to_group: z.string().optional().describe('Group of recipient; defaults to sender group'),
    }
  }, async ({ to_user, payload, to_group }) => {
    const caller = registry.getBySessionId(callerSessionId);
    if (!caller) {
      return { content: [{ type: 'text' as const, text: 'Error: sender not registered' }], isError: true };
    }
    const targetGroup = to_group ?? caller.group;
    const recipient = registry.findAgent(to_user, targetGroup);
    if (!recipient) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${targetGroup}/${to_user} is not online` }],
        isError: true
      };
    }
    await natsBridge.publishMessage({
      from_user: caller.user,
      from_group: caller.group,
      to_user,
      to_group: targetGroup,
      payload
    });
    return { content: [{ type: 'text' as const, text: 'Message sent' }] };
  });

  server.registerTool('list_users', {
    description: 'List currently connected users in a group.',
    inputSchema: {
      group: z.string().optional().describe('Group to list; defaults to caller group'),
    }
  }, async ({ group }) => {
    const caller = registry.getBySessionId(callerSessionId);
    const targetGroup = group ?? caller?.group;
    if (!targetGroup) return { content: [{ type: 'text' as const, text: '[]' }] };
    const users = registry.listUsersInGroup(targetGroup).map(e => e.user);
    return { content: [{ type: 'text' as const, text: JSON.stringify(users) }] };
  });

  server.registerTool('list_groups', {
    description: 'List all groups with at least one connected agent.',
    inputSchema: {}
  }, async () => {
    const groups = registry.listAllGroups();
    return { content: [{ type: 'text' as const, text: JSON.stringify(groups) }] };
  });
}
