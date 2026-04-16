export interface UnguibusMessage {
  from_user: string;
  from_group: string;
  to_user: string;
  to_group: string;
  payload: unknown;
}

export interface SendMessageOptions {
  to_user: string;
  payload: unknown;
  to_group?: string;
}

export interface ListUsersOptions {
  group?: string;
}

export interface ClientConfig {
  user: string;
  group: string;
  server_url?: string;
}
