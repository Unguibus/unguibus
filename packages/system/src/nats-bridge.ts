import { connect, StringCodec } from 'nats';
import type { NatsConnection, Subscription } from 'nats';
import type { AgentRegistry } from './registry.js';
import type { UnguibusMessage } from './types.js';

const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';
const SUBJECT_PREFIX = 'unguibus.queue';
const WILDCARD_SUBJECT = `${SUBJECT_PREFIX}.>`;
const sc = StringCodec();

export class NatsBridge {
  private nc: NatsConnection | null = null;
  private sub: Subscription | null = null;

  constructor(private registry: AgentRegistry) {}

  async start(): Promise<void> {
    this.nc = await connect({ servers: NATS_URL });
    this.sub = this.nc.subscribe(WILDCARD_SUBJECT);
    this.dispatchLoop();
  }

  async stop(): Promise<void> {
    this.sub?.unsubscribe();
    await this.nc?.drain();
  }

  private async dispatchLoop(): Promise<void> {
    if (!this.sub) return;
    for await (const msg of this.sub) {
      try {
        const payload = JSON.parse(sc.decode(msg.data)) as UnguibusMessage;
        this.dispatch(payload);
      } catch (err) {
        console.error('[nats-bridge] Failed to parse message:', err);
      }
    }
  }

  private dispatch(msg: UnguibusMessage): void {
    const entry = this.registry.findAgent(msg.to_user, msg.to_group);
    if (!entry) {
      console.warn(`[nats-bridge] No online agent for ${msg.to_group}/${msg.to_user}`);
      return;
    }
    entry.lowLevelServer.notification({
      method: 'notifications/unguibus/message',
      params: { message: msg }
    }).catch(err => console.error('[nats-bridge] Notification failed:', err));
  }

  async publishMessage(msg: UnguibusMessage): Promise<void> {
    if (!this.nc) throw new Error('NATS not connected');
    const subject = `${SUBJECT_PREFIX}.${msg.to_group}.${msg.to_user}`;
    this.nc.publish(subject, sc.encode(JSON.stringify(msg)));
  }
}
