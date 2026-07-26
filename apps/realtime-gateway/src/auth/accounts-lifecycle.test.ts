import { afterEach, describe, expect, test } from "bun:test";
import { startAccounts } from "./accounts";

const SECRET = "an-adequately-long-test-secret-0123456789";
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await Bun.$`rm -rf ${dir}`.quiet().nothrow();
});

function tempDir(): string {
  const dir = `${import.meta.dir}/../../node_modules/.test-acct-life-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  dirs.push(dir);
  return dir;
}

describe("accounts lifecycle (adversarial review 2026-07-26)", () => {
  test("after close, resolving and handling refuse cleanly instead of hitting a closed database", async () => {
    const accounts = await startAccounts({ dir: tempDir(), secret: SECRET, baseUrl: "http://127.0.0.1:8790" });
    const signup = await accounts.handler(new Request("http://127.0.0.1:8790/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "late@test.dev", password: "password1234", name: "Late" }),
    }));
    expect(signup.status).toBe(200);
    const cookie = signup.headers.getSetCookie().map(entry => entry.split(";")[0]).join("; ");
    const authenticated = new Request("http://127.0.0.1:8790/v1/engines", { headers: { cookie } });
    expect(await accounts.resolve(authenticated)).not.toBeNull();

    accounts.close();

    // A request that arrives inside the shutdown window is refused, not crashed on.
    expect(await accounts.resolve(authenticated)).toBeNull();
    expect(await accounts.resolve(new Request("http://127.0.0.1:8790/v1/engines", { headers: { "x-api-key": "vox_whatever" } }))).toBeNull();
    const late = await accounts.handler(new Request("http://127.0.0.1:8790/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "late@test.dev", password: "password1234" }),
    }));
    expect(late.status).toBe(503);
    expect((await late.json() as { error: { code: string } }).error.code).toBe("accounts_closing");

    // Idempotent: a second close (the drain racing the server stop) is not an error.
    accounts.close();
  });
});
