import { AgentRegistry } from './registry.js';
import { NatsBridge } from './nats-bridge.js';
import { createHttpServer } from './http-server.js';

async function main() {
  const registry = new AgentRegistry();
  const natsBridge = new NatsBridge(registry);

  await natsBridge.start();
  console.log('[main] NATS connected');

  const { start } = createHttpServer(registry, natsBridge);
  start();

  const shutdown = async (signal: string) => {
    console.log(`[main] ${signal}, shutting down`);
    await natsBridge.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('[main] Fatal:', err);
  process.exit(1);
});
