export interface CloudEvent {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  time: string;
  datacontenttype: "application/json";
  data: unknown;
}

export interface StoredEvent extends CloudEvent {
  publishedAt: string;
}

export interface PublishResult {
  event: StoredEvent;
  created: boolean;
}

export interface PublishInput {
  source: string;
  type: string;
  data?: unknown;
  time?: string;
  id?: string;
  specversion?: string;
  datacontenttype?: string;
}

export interface QueryInput {
  type?: string;
  source?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

export class ServiceError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "ServiceError";
  }
}
