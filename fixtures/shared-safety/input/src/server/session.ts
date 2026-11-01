export interface ServerSession {
  readonly userId: number;
}

export const serverSession: ServerSession = { userId: 0 };
