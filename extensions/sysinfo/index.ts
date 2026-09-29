/**
 * sysinfo — fastfetch-style system info injection
 *
 * Discovers OS, hardware, time, and locale metadata on session start
 * and injects it into the system prompt so the model knows the machine
 * it's running on.
 */
import * as os from "node:os";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
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

function parseDataSize(value: number, unit: string): number {
  const u = unit.toUpperCase();
  if (u === "B") return value;
  if (u === "KB" || u === "KIB") return value * 1024;
  if (u === "MB" || u === "MIB") return value * 1024 ** 2;
  if (u === "GB" || u === "GIB") return value * 1024 ** 3;
  if (u === "TB" || u === "TIB") return value * 1024 ** 4;
  return value;
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

function formatGpu(csv: string): string {
  // nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
  // e.g. "NVIDIA GeForce RTX 5070, 12227 MiB"
  const parts = csv.split(",").map((s) => s.trim());
  if (parts.length !== 2) return csv;
  const [name, memRaw] = parts;
  const m = memRaw.match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!m) return csv;
  const bytes = parseDataSize(parseFloat(m[1]), m[2]);
  return `${name} (${formatBytes(bytes)})`;
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

  // GPU
  const gpuCheck = exec("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"]);
  if (gpuCheck) {
    info["GPU"] = formatGpu(gpuCheck);
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

  pi.on("before_agent_start", async (event) => {
    if (!staticInfoText) return;

    return {
      systemPrompt:
        event.systemPrompt +
        `

## System Information

You are running on the following machine:

${staticInfoText}
Current time: ${new Date().toString()}
`,
    };
  });
}
