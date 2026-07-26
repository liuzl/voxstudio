/**
 * The resolved identity of one request or one WebSocket (docs/auth.md, decision 4).
 * Business code sees only this — never a cookie, header, or token. Self-hosted
 * deployments resolve to the single owner ("none" without a token, "token" with one);
 * hosted accounts (docs/auth.md phase 3) add "session" and "apiKey" resolvers behind
 * the same two fields.
 */
export interface AuthContext {
  userId: string;
  via: "none" | "token" | "session" | "apiKey";
}

/** The self-hosted single owner: every local deployment resolves to this userId. */
export const OWNER_USER_ID = "owner";
