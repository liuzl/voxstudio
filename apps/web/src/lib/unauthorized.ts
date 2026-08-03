/**
 * One place the app learns that its credential stopped working. Every REST helper
 * reports a 401 here (docs/auth.md phase 3: a session can expire or be signed out in
 * another tab mid-use), and the shell listens so it can show the sign-in card instead
 * of a panel full of failures. A protected self-host uses the same signal to return to
 * its shared-token entrance; an unprotected self-host ignores it.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function onUnauthorized(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function reportUnauthorized(): void {
  for (const listener of [...listeners]) listener();
}
