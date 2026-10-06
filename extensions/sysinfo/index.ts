/**
 * sysinfo — fastfetch-style system info injection
 *
 * Discovers OS, hardware, time, and locale metadata on session start and
 * contributes them as the <system_info> prompt section, so the model knows
 * the machine it's running on without forcing a whole system prompt.
 *
 * GPU handling: name and UUID come from /proc (reading them does not wake a
 * runtime-suspended GPU); the fixed VRAM total is cached on disk per UUID so
 * nvidia-smi — which wakes a suspended GPU for ~2 s — only runs for a device
 * that has never been seen before.
 */
import * as os from "node:os";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── helpers ──────────────────────────────────────────────────────────

function exec(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 3_000,
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
  } catch {
    return "";
  }
}

function readFile(path: string): string {
  try {
    return fs.readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  let value = bytes;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// ── gpu cache ────────────────────────────────────────────────────────

const GPU_PROC_DIR = "/proc/driver/nvidia/gpus";
const CACHE_VERSION = 1;

interface GpuCache {
  version: number;
  gpus: Record<string, { vramBytes: number; updatedAt: string }>;
}

function cachePath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(os.homedir(), ".pi", "agent");
  return join(agentDir, "tmp", "sysinfo-gpu.json");
}

function loadGpuCache(): GpuCache {
  try {
    const parsed = JSON.parse(readFile(cachePath())) as GpuCache;
    if (parsed.version === CACHE_VERSION && parsed.gpus && typeof parsed.gpus === "object") {
      return parsed;
    }
  } catch {
    // missing or corrupt cache — rebuilt on demand below
  }
  return { version: CACHE_VERSION, gpus: {} };
}

function saveGpuCache(cache: GpuCache): void {
  try {
    const file = cachePath();
    fs.mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    // the cache is an optimization — never fail startup because of it
  }
}

interface GpuInfo {
  name: string;
  uuid: string;
}

/** Name/UUID via /proc: cheap and safe even while the GPU is suspended. */
function discoverGpus(): GpuInfo[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(GPU_PROC_DIR);
  } catch {
    return [];
  }
  const gpus: GpuInfo[] = [];
  for (const entry of entries) {
    const text = readFile(join(GPU_PROC_DIR, entry, "information"));
    const name = text.match(/^Model:\s+(.+)$/m)?.[1];
    const uuid = text.match(/^GPU UUID:\s+(.+)$/m)?.[1];
    if (name && uuid) gpus.push({ name, uuid });
  }
  return gpus;
}

/** VRAM totals by GPU UUID. The total is a fixed property of the device, so
 *  it is fetched once per UUID with nvidia-smi and cached on disk. */
function gpuVramBytes(uuids: string[]): Record<string, number> {
  const cache = loadGpuCache();
  if (uuids.some((uuid) => !(uuid in cache.gpus))) {
    const out = exec("nvidia-smi", ["--query-gpu=uuid,memory.total", "--format=csv,noheader,nounits"]);
    let dirty = false;
    for (const row of out.split("\n")) {
      const [uuid, mib] = row.split(",").map((s) => s.trim());
      const bytes = Number(mib) * 1024 * 1024;
      if (uuid && Number.isFinite(bytes) && bytes > 0) {
        cache.gpus[uuid] = { vramBytes: bytes, updatedAt: new Date().toISOString() };
        dirty = true;
      }
    }
    if (dirty) saveGpuCache(cache);
  }
  const result: Record<string, number> = {};
  for (const uuid of uuids) {
    const bytes = cache.gpus[uuid]?.vramBytes;
    if (bytes) result[uuid] = bytes;
  }
  return result;
}

// ── discovery ────────────────────────────────────────────────────────

function discoverStatic(): Record<string, string> {
  const info: Record<string, string> = {};

  // OS (NixOS version looks like "26.11.20260718.61b7c44 (Zokor)")
  const osRelease = readFile("/run/current-system/nixos-version");
  if (osRelease) {
    const m = osRelease.match(/^(\d+\.\d+)/);
    info["OS"] = m ? `NixOS ${m[1]} (${osRelease})` : osRelease;
  } else {
    info["OS"] = `${os.type()} ${os.release()}`;
  }
  info["Kernel"] = os.release();
  info["Architecture"] = os.arch();

  // CPU
  const cpuModel = (os.cpus()[0]?.model ?? "").replace(/\s+/g, " ").trim();
  const cpuThreads = os.cpus().length;
  info["CPU"] = `${cpuModel} (${cpuThreads} threads)`;

  // GPU — name via /proc (no GPU wake), VRAM total cached per UUID
  const gpus = discoverGpus();
  if (gpus.length > 0) {
    const vram = gpuVramBytes(gpus.map((g) => g.uuid));
    info["GPU"] = gpus
      .map((g) => (vram[g.uuid] ? `${g.name} (${formatBytes(vram[g.uuid])})` : g.name))
      .join(", ");
  }

  // RAM
  info["RAM"] = `${formatBytes(os.freemem())} free / ${formatBytes(os.totalmem())} total`;

  // Storage
  const homeFree = exec("df", ["-h", "--output=size,used,avail,pcent", os.homedir()]);
  const homeLine = homeFree.split("\n")[1];
  if (homeLine) {
    const parts = homeLine.trim().split(/\s+/);
    if (parts.length >= 4) {
      info["Storage"] = `total ${parts[0]}B, used ${parts[1]}B, avail ${parts[2]}B (${parts[3]} used)`;
    }
  }

  // Hostname & Network (exclude docker/bridge interfaces)
  info["Hostname"] = os.hostname();
  const ips = Object.entries(os.networkInterfaces())
    .flatMap(([name, addrs]) => {
      if (name.startsWith("docker") || name.startsWith("br-") || name.startsWith("veth")) return [];
      return (addrs ?? []).filter((a) => !a.internal && (a.family === "IPv4" || a.family === 4));
    })
    .map((a) => a.address);
  if (ips.length > 0) {
    info["LAN IP"] = ips.join(", ");
  }

  // Time / locale
  info["Timezone"] = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Locale
  const localeEnv = process.env.LANG || process.env.LC_ALL || "";
  if (localeEnv) info["Locale"] = localeEnv;

  // User
  info["User"] = os.userInfo().username;
  info["Shell"] = process.env.SHELL || os.userInfo().shell || "";

  return info;
}

// ── extension ────────────────────────────────────────────────────────

export default function sysinfo(pi: ExtensionAPI) {
  let staticInfoText = "";

  pi.on("session_start", async () => {
    const info = discoverStatic();
    staticInfoText = Object.entries(info)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  });

  pi.on("before_agent_start", (event) => {
    const lines = [staticInfoText, `Current time: ${new Date().toString()}`].filter(Boolean);
    event.systemPromptOptions.sections.system_info = `You are running on the following machine:\n\n${lines.join("\n")}`;
  });
}
