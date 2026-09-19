/**
 * One-command demo: spawns both worker agents + both A2A proxies, waits
 * for readiness, runs the coordinator, then leaves agents/proxies running
 * so the trace can be inspected live.
 *
 *   npm run demo                      one coordinator run
 *   npm run demo -- --repeat=3        three runs (~8s apart, new trace each)
 *   npm run demo -- --repeat=0        loop forever until Ctrl+C
 *   --interval=<ms>                   delay between runs (default 8000)
 *
 * Prereq: collector running (npm run dev:collector).
 * Windows gotcha: stop children via Ctrl+C in THIS terminal — killed/orphaned
 * tsx children hold ports 8800/8801/9101/9102. If orphaned, free them with:
 *   npx kill-port 8800 8801 9101 9102
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const proxyFile = resolve(root, "packages/adapters/src/a2a/proxy.ts");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
// --repeat with no value means "forever", same as 0.
const REPEAT =
  args.repeat === "true" ? 0 : Number.isFinite(Number(args.repeat)) ? Number(args.repeat) : 1;
const INTERVAL = Number.isFinite(Number(args.interval)) ? Number(args.interval) : 8000;

const children: ChildProcess[] = [];

// Registered before any spawn/loop so a kill during startup or a --repeat
// cycle still cleans up children (orphans hold ports 8800/8801/9101/9102).
const killChildren = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", killChildren);
process.on("SIGTERM", killChildren);

function spawnTsx(file: string, env: Record<string, string>, label: string) {
  const child = spawn(process.execPath, ["--import", "tsx", file], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("exit", (code) => console.log(`[${label}] exited (${code})`));
  children.push(child);
  return child;
}

async function waitFor(url: string, label: string, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url, { method: "HEAD" });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`${label} did not come up at ${url}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Worker agents.
spawnTsx(resolve(here, "agents/researcher.ts"), {}, "researcher");
spawnTsx(resolve(here, "agents/reviewer.ts"), {}, "reviewer");

// One proxy in front of each agent (spec §9 topology).
spawnTsx(
  proxyFile,
  { A2A_PROXY_PORT: "8800", A2A_TARGET_URL: "http://localhost:9101" },
  "proxy:researcher",
);
spawnTsx(
  proxyFile,
  { A2A_PROXY_PORT: "8801", A2A_TARGET_URL: "http://localhost:9102" },
  "proxy:reviewer",
);

await waitFor("http://localhost:8800/healthz", "proxy:researcher");
await waitFor("http://localhost:8801/healthz", "proxy:reviewer");
// A bound proxy doesn't prove the upstream agent is up — probe both agents
// too (any HTTP response, even 404, means the port is bound).
await waitFor("http://localhost:9101/a2a", "researcher");
await waitFor("http://localhost:9102/a2a", "reviewer");

const { runCoordinator } = await import("./coordinator.js");

for (let i = 0; REPEAT === 0 || i < REPEAT; i++) {
  if (i > 0) await sleep(INTERVAL);
  if (REPEAT !== 1) console.log(`\n=== coordinator run ${i + 1} ===`);
  try {
    await runCoordinator();
  } catch (err) {
    console.error("coordinator run failed (agents/proxies still up):", err);
  }
}

console.log("\ndemo running — ctrl+c to stop agents/proxies");
console.log("inspect traces at http://localhost:5173 (or :8787/v1/traces)");
