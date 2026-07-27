import { afterEach, describe, expect, test } from "bun:test";
import { parseConfig } from "@voxstudio/config";
import { startGateway, type GatewayServer } from "./server";

/**
 * M-5 (adversarial review 2026-07-26): with no configured public origin the discovery
 * documents used to publish the gateway's own bind address — a loopback host:port on
 * every tunnelled deployment, which both leaks the internal port and hands agents
 * instructions they cannot follow. The documents now describe the origin the request
 * actually arrived on.
 */

const config = parseConfig({
  engines: {
    asr: { base_url: "http://asr.test" },
    llm: { base_url: "http://llm.test" },
    tts: { base_url: "http://tts.test" },
  },
});

const SECRET = "an-adequately-long-test-secret-0123456789";

let gateway: GatewayServer | undefined;
const dirs: string[] = [];

afterEach(async () => {
  await gateway?.stop();
  gateway = undefined;
  for (const dir of dirs.splice(0)) await Bun.$`rm -rf ${dir}`.quiet().nothrow();
});

function tempDir(): string {
  const dir = `${import.meta.dir}/../node_modules/.test-origin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  dirs.push(dir);
  return dir;
}

/** A tunnel's headers: the browser's origin, not the loopback socket we were reached on. */
const throughTunnel = {
  host: "voxstudio.example",
  "x-forwarded-host": "voxstudio.example",
  "x-forwarded-proto": "https",
};

describe("the discovery surface describes the origin it was reached on", () => {
  test("behind a tunnel with no configured origin, it publishes the public one — never the bind address", async () => {
    gateway = startGateway({
      config,
      port: 0,
      accounts: { dir: tempDir(), secret: SECRET, rateLimit: { window: 60, max: 1_000 } },
      fetch: async () => Response.json({ voices: [] }),
    });
    const internalPort = new URL(gateway.url).port;

    const page = await (await fetch(new URL("/agent", gateway.url), { headers: throughTunnel })).text();
    expect(page).toContain("https://voxstudio.example/llms.txt");
    expect(page).toContain("https://voxstudio.example/v1");
    // The thing that used to leak: our own bind address and port.
    expect(page).not.toContain("127.0.0.1");
    expect(page).not.toContain(internalPort);

    const index = await (await fetch(new URL("/llms.txt", gateway.url), { headers: throughTunnel })).text();
    expect(index).toContain("https://voxstudio.example/agent");
    expect(index).not.toContain("127.0.0.1");

    const document = await (await fetch(new URL("/openapi.json", gateway.url), { headers: throughTunnel })).json() as { servers: { url: string }[] };
    expect(document.servers[0]?.url).toBe("https://voxstudio.example");
  });

  test("a configured origin still wins — it is the deployment's stated truth", async () => {
    gateway = startGateway({
      config,
      port: 0,
      accounts: { dir: tempDir(), secret: SECRET, baseUrl: "https://configured.example", rateLimit: { window: 60, max: 1_000 } },
      fetch: async () => Response.json({ voices: [] }),
    });
    // Even when a request claims otherwise, the configured origin is what we publish.
    const document = await (await fetch(new URL("/openapi.json", gateway.url), { headers: throughTunnel })).json() as { servers: { url: string }[] };
    expect(document.servers[0]?.url).toBe("https://configured.example");
  });

  test("a local request with no forwarding still gets a usable local origin", async () => {
    gateway = startGateway({
      config,
      port: 0,
      accounts: { dir: tempDir(), secret: SECRET, rateLimit: { window: 60, max: 1_000 } },
      fetch: async () => Response.json({ voices: [] }),
    });
    const origin = new URL(gateway.url).origin;
    const document = await (await fetch(new URL("/openapi.json", gateway.url))).json() as { servers: { url: string }[] };
    // Reached directly on loopback, loopback is the honest answer.
    expect(document.servers[0]?.url).toBe(origin);
  });

  test("a hosted deployment without a configured origin says so at startup", async () => {
    const lines: string[] = [];
    gateway = startGateway({
      config,
      port: 0,
      accounts: { dir: tempDir(), secret: SECRET, rateLimit: { window: 60, max: 1_000 } },
      fetch: async () => Response.json({ voices: [] }),
      log: line => lines.push(line),
    });
    // Better Auth's own origin check keys on the configured base URL, so a tunnelled
    // deployment that omits it fails at key creation — worth one loud line.
    expect(lines.some(line => line.includes("VOX_AUTH_BASE_URL"))).toBe(true);
  });
});

describe("a self-hosted studio answers the machine paths honestly", () => {
  test("the discovery paths are a structured 404, not the app shell with a 200", async () => {
    const dir = `${import.meta.dir}/../node_modules/.test-selfhosted-${Date.now().toString(36)}`;
    await Bun.write(`${dir}/index.html`, "<html><body>studio-shell</body></html>");
    dirs.push(dir);
    gateway = startGateway({
      config,
      port: 0,
      staticAssets: { "/index.html": `${dir}/index.html` },
      fetch: async () => Response.json({}),
    });

    for (const path of ["/agent", "/llms.txt", "/openapi.json"]) {
      const response = await fetch(new URL(path, gateway.url));
      // A machine can tell "not here" from "here is a web page".
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      expect(response.headers.get("content-type")).toContain("application/json");
      const body = await response.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("discovery_disabled");
      expect(body.error.message).toContain("accounts");
    }
    // Ordinary deep links still get the shell: this is about machine paths only.
    const page = await fetch(new URL("/settings", gateway.url));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("studio-shell");
  });

  test("healthz keeps the session count for the owner and withholds it from a hosted deployment", async () => {
    gateway = startGateway({ config, port: 0, fetch: async () => Response.json({}) });
    const selfHosted = await (await fetch(new URL("/healthz", gateway.url))).json() as Record<string, unknown>;
    expect(selfHosted.auth).toBe("self");
    expect(selfHosted.sessions).toBe(0);
    await gateway.stop();

    gateway = startGateway({
      config,
      port: 0,
      accounts: { dir: tempDir(), secret: SECRET, rateLimit: { window: 60, max: 1_000 } },
      fetch: async () => Response.json({}),
    });
    const hosted = await (await fetch(new URL("/healthz", gateway.url))).json() as Record<string, unknown>;
    expect(hosted.auth).toBe("accounts");
    // Live-session counts are nobody's business on a public entrance.
    expect("sessions" in hosted).toBe(false);
  });
});
