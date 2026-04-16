import { EventEmitter } from 'events';
import type { UnguibusMessage, SendMessageOptions, ListUsersOptions, ClientConfig } from './types.js';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:47667';
const SSE_ENDPOINT = '/sse';
const MESSAGES_ENDPOINT = '/messages';

export class UnguibusClient extends EventEmitter {
  private user: string;
  private group: string;
  private serverUrl: string;
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;
  private pendingRequests = new Map<number, (response: unknown) => void>();
  private requestId = 0;

  constructor(config: ClientConfig) {
    super();
    this.user = config.user;
    this.group = config.group;
    this.serverUrl = config.server_url ?? DEFAULT_SERVER_URL;
  }

  async connect(): Promise<void> {
    const sseUrl = `${this.serverUrl}${SSE_ENDPOINT}`;
    this.abortController = new AbortController();
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        this.abortController?.abort();
        this.emit('error', new Error('Connection timeout'));
      }
    }, 10000);

    try {
      const response = await fetch(sseUrl, {
        signal: this.abortController.signal,
        headers: {
          'X-Unguibus-User': this.user,
          'X-Unguibus-Group': this.group,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      if (!response.body) throw new Error('No response body');

      this.setupStreamListener(response.body, timeout, () => {
        resolved = true;
      });
    } catch (err) {
      clearTimeout(timeout);
      if (resolved) return;
      resolved = true;
      throw err;
    }
  }

  private async setupStreamListener(
    body: ReadableStream<Uint8Array>,
    timeout: NodeJS.Timeout,
    onConnect: () => void
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line) continue;

          if (line.startsWith('event: ')) {
            const eventType = line.substring(7);
            const nextIndex = lines.findIndex(l => l.startsWith('data: '));
            if (nextIndex !== -1) {
              const dataLine = lines[nextIndex];
              const data = dataLine.substring(6);

              if (eventType === 'endpoint') {
                clearTimeout(timeout);
                const url = new URL(data, this.serverUrl);
                this.sessionId = url.searchParams.get('sessionId');
                if (!this.sessionId) throw new Error('Failed to establish session');
                onConnect();
              } else if (eventType === 'message') {
                this.handleMessage(JSON.parse(data));
              }
            }
          }
        }
      }
    } catch (err) {
      this.emit('error', err);
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
    }
  }

  private handleMessage(data: any): void {
    // Handle tool responses
    if (data.id && this.pendingRequests.has(data.id)) {
      const resolve = this.pendingRequests.get(data.id)!;
      this.pendingRequests.delete(data.id);
      resolve(data.result);
      return;
    }

    // Handle incoming notifications
    if (data.method === 'notifications/unguibus/message') {
      const message = data.params.message as UnguibusMessage;
      this.emit('message', message);
    }
  }

  async sendMessage(options: SendMessageOptions): Promise<void> {
    if (!this.sessionId) throw new Error('Not connected');

    const requestId = ++this.requestId;
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name: 'send_message',
        arguments: {
          to_user: options.to_user,
          payload: options.payload,
          ...(options.to_group && { to_group: options.to_group }),
        },
      },
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, (response) => {
        if ((response as any).isError) {
          reject(new Error((response as any).content[0]?.text || 'Send failed'));
        } else {
          resolve();
        }
      });

      this.postMessage(request).catch(reject);

      // Timeout after 10s
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 10000);
    });
  }

  async listUsers(options?: ListUsersOptions): Promise<string[]> {
    if (!this.sessionId) throw new Error('Not connected');

    const requestId = ++this.requestId;
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name: 'list_users',
        arguments: {
          ...(options?.group && { group: options.group }),
        },
      },
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, (response) => {
        try {
          const text = (response as any).content[0]?.text;
          resolve(JSON.parse(text || '[]'));
        } catch (err) {
          reject(new Error('Failed to parse users list'));
        }
      });

      this.postMessage(request).catch(reject);

      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 10000);
    });
  }

  async listGroups(): Promise<string[]> {
    if (!this.sessionId) throw new Error('Not connected');

    const requestId = ++this.requestId;
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name: 'list_groups',
        arguments: {},
      },
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, (response) => {
        try {
          const text = (response as any).content[0]?.text;
          resolve(JSON.parse(text || '[]'));
        } catch (err) {
          reject(new Error('Failed to parse groups list'));
        }
      });

      this.postMessage(request).catch(reject);

      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 10000);
    });
  }

  private async postMessage(data: unknown): Promise<void> {
    if (!this.sessionId) throw new Error('Not connected');

    const url = `${this.serverUrl}${MESSAGES_ENDPOINT}?sessionId=${this.sessionId}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
  }

  disconnect(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.sessionId = null;
    this.pendingRequests.clear();
    this.removeAllListeners();
  }
}

export type { UnguibusMessage, SendMessageOptions, ListUsersOptions, ClientConfig };
