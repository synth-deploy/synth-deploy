import type { Session, UserId } from "./types.js";
import type { ISessionStore } from "./store-interfaces.js";

/**
 * In-memory session store. Returns deep clones to prevent external mutation.
 */
export class SessionStore implements ISessionStore {
  private sessions = new Map<string, Session>(); // keyed by session id
  private tokenIndex = new Map<string, string>(); // token -> session id
  private refreshTokenIndex = new Map<string, string>(); // refreshToken -> session id

  create(session: Session): Session {
    this.sessions.set(session.id, structuredClone(session));
    this.tokenIndex.set(session.token, session.id);
    this.refreshTokenIndex.set(session.refreshToken, session.id);
    return structuredClone(session);
  }

  getByToken(token: string): Session | undefined {
    const sessionId = this.tokenIndex.get(token);
    if (!sessionId) return undefined;
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    // Check expiry
    if (session.expiresAt < new Date()) {
      this.deleteBySessionId(sessionId);
      return undefined;
    }
    return structuredClone(session);
  }

  getByRefreshToken(refreshToken: string): Session | undefined {
    const sessionId = this.refreshTokenIndex.get(refreshToken);
    if (!sessionId) return undefined;
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : undefined;
  }

  deleteByToken(token: string): void {
    const sessionId = this.tokenIndex.get(token);
    if (sessionId) {
      this.deleteBySessionId(sessionId);
    }
  }

  deleteByUserId(userId: UserId): void {
    for (const [id, session] of this.sessions) {
      if (session.userId === userId) {
        this.deleteBySessionId(id);
      }
    }
  }

  deleteExpired(): void {
    const now = new Date();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt < now) {
        this.deleteBySessionId(id);
      }
    }
  }

  private deleteBySessionId(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      this.tokenIndex.delete(session.token);
      this.refreshTokenIndex.delete(session.refreshToken);
      this.sessions.delete(id);
    }
  }
}
