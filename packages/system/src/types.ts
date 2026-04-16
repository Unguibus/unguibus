export interface UnguibusMessage {
  from_user: string;
  from_group: string;
  to_user: string;
  to_group: string;
  payload: unknown;
}
