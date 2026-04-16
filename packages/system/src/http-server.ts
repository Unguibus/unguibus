import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { AgentRegistry } from './registry.js';
import type { NatsBridge } from './nats-bridge.js';
import { registerTools } from './tools.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

export function createHttpServer(registry: AgentRegistry, natsBridge: NatsBridge) {
  const app = express();
  app.use(express.json());

  const transports = new Map<string, SSEServerTransport>();

  app.get('/sse', async (req, res) => {
    const user = req.headers['x-unguibus-user'] as string | undefined;
    const group = req.headers['x-unguibus-group'] as string | undefined;

    if (!user || !group) {
      res.status(400).send('Missing X-Unguibus-User or X-Unguibus-Group headers');
      return;
    }

    const mcpServer = new McpServer(
      { name: 'unguibus', version: '1.0.0' },
      { capabilities: { logging: {} } }
    );

    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    registerTools(mcpServer, registry, natsBridge, sessionId);

    registry.register({
      user,
      group,
      mcpServer,
      lowLevelServer: (mcpServer as unknown as { server: import('@modelcontextprotocol/sdk/server/index.js').Server }).server,
      sessionId,
      connectedAt: new Date(),
    });

    transport.onclose = () => {
      transports.delete(sessionId);
      registry.unregister(sessionId);
      console.log(`[http] Disconnected: ${group}/${user}`);
    };

    await mcpServer.connect(transport);
    console.log(`[http] Connected: ${group}/${user} (${sessionId})`);
  });

  app.post('/messages', async (req, res) => {
    const sessionId = req.query['sessionId'] as string | undefined;
    if (!sessionId) { res.status(400).send('Missing sessionId'); return; }

    const transport = transports.get(sessionId);
    if (!transport) { res.status(404).send('Session not found'); return; }

    await transport.handlePostMessage(req, res, req.body);
  });

  return {
    start: () => app.listen(PORT, '127.0.0.1', () =>
      console.log(`[http] unguibus listening on http://127.0.0.1:${PORT}`)
    )
  };
}
