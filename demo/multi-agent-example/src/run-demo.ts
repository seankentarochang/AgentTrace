/**
 * One-command demo: spawns both worker agents + both A2A proxies, waits
 * for readiness, runs the coordinator, then leaves agents/proxies running
 * so the trace can be inspected live.
 *
 * Prereq: collector running (npm run dev:collector).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const proxyFile = resolve(root, "packages/adapters/src/a2a/proxy.ts");

const children: ChildProcess[] = [];

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

await waitFor("http://localhost:8800/a2a", "proxy:researcher");
await waitFor("http://localhost:8801/a2a", "proxy:reviewer");

await import("./coordinator.js");

process.on("SIGINT", () => {
  for (const c of children) c.kill();
  process.exit(0);
});
console.log("\ndemo running — ctrl+c to stop agents/proxies");
