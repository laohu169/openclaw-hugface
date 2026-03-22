import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePortAvailable } from "../infra/ports.js";
import { rawDataToString } from "../infra/ws.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR } from "../utils.js";
import {
  CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS,
  CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS,
  CHROME_LAUNCH_READY_POLL_MS,
  CHROME_LAUNCH_READY_WINDOW_MS,
  CHROME_REACHABILITY_TIMEOUT_MS,
  CHROME_STDERR_HINT_MAX_CHARS,
  CHROME_STOP_PROBE_TIMEOUT_MS,
  CHROME_STOP_TIMEOUT_MS,
  CHROME_WS_READY_TIMEOUT_MS,
} from "./cdp-timeouts.js";
import { appendCdpPath, fetchCdpChecked, isWebSocketUrl, openCdpWebSocket } from "./cdp.helpers.js";
import { normalizeCdpWsUrl } from "./cdp.js";
import {
  type BrowserExecutable,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
import {
  decorateOpenClawProfile,
  ensureProfileCleanExit,
  isProfileDecorated,
} from "./chrome.profile-decoration.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";
import {
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "./constants.js";

const log = createSubsystemLogger("browser").child("chrome");

export type { BrowserExecutable } from "./chrome.executables.js";
export {
  findChromeExecutableLinux,
  findChromeExecutableMac,
  findChromeExecutableWindows,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
export {
  decorateOpenClawProfile,
  ensureProfileCleanExit,
  isProfileDecorated,
} from "./chrome.profile-decoration.js";

function exists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export type RunningChrome = {
  pid: number;
  exe: BrowserExecutable;
  userDataDir: string;
  cdpPort: number;
  startedAt: number;
  proc: ChildProcessWithoutNullStreams;
};

function resolveBrowserExecutable(resolved: ResolvedBrowserConfig): BrowserExecutable | null {
  return resolveBrowserExecutableForPlatform(resolved, process.platform);
}

export function resolveOpenClawUserDataDir(profileName = DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME) {
  return path.join(CONFIG_DIR, "browser", profileName, "user-data");
}

function cdpUrlForPort(cdpPort: number) {
  return `http://127.0.0.1:${cdpPort}`;
}

async function canOpenWebSocket(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const ws = openCdpWebSocket(url, { handshakeTimeoutMs: timeoutMs });
    ws.once("open", () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(true);
    });
    ws.once("error", () => resolve(false));
  });
}

export async function isChromeReachable(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
): Promise<boolean> {
  if (isWebSocketUrl(cdpUrl)) {
    // Direct WebSocket endpoint — probe via WS handshake.
    return await canOpenWebSocket(cdpUrl, timeoutMs);
  }
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  return Boolean(version);
}

type ChromeVersion = {
  webSocketDebuggerUrl?: string;
  Browser?: string;
  "User-Agent"?: string;
};

async function fetchChromeVersion(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
): Promise<ChromeVersion | null> {
  const ctrl = new AbortController();
  const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
  try {
    const versionUrl = appendCdpPath(cdpUrl, "/json/version");
    const res = await fetchCdpChecked(versionUrl, timeoutMs, { signal: ctrl.signal });
    const data = (await res.json()) as ChromeVersion;
    if (!data || typeof data !== "object") {
      return null;
    }
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function getChromeWebSocketUrl(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
): Promise<string | null> {
  if (isWebSocketUrl(cdpUrl)) {
    // Direct WebSocket endpoint — the cdpUrl is already the WebSocket URL.
    return cdpUrl;
  }
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  const wsUrl = String(version?.webSocketDebuggerUrl ?? "").trim();
  if (!wsUrl) {
    return null;
  }
  return normalizeCdpWsUrl(wsUrl, cdpUrl);
}

async function canRunCdpHealthCommand(
  wsUrl: string,
  timeoutMs = CHROME_WS_READY_TIMEOUT_MS,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const ws = openCdpWebSocket(wsUrl, {
      handshakeTimeoutMs: timeoutMs,
    });
    let settled = false;
    const onMessage = (raw: Parameters<typeof rawDataToString>[0]) => {
      if (settled) {
        return;
      }
      let parsed: { id?: unknown; result?: unknown } | null = null;
      try {
        parsed = JSON.parse(rawDataToString(raw)) as { id?: unknown; result?: unknown };
      } catch {
        return;
      }
      if (parsed?.id !== 1) {
        return;
      }
      finish(Boolean(parsed.result && typeof parsed.result === "object"));
    };

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      ws.off("message", onMessage);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(value);
    };
    const timer = setTimeout(
      () => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        finish(false);
      },
      Math.max(50, timeoutMs + 25),
    );

    ws.once("open", () => {
      try {
        ws.send(
          JSON.stringify({
            id: 1,
            method: "Browser.getVersion",
          }),
        );
      } catch {
        finish(false);
      }
    });

    ws.on("message", onMessage);

    ws.once("error", () => {
      finish(false);
    });
    ws.once("close", () => {
      finish(false);
    });
  });
}

export async function isChromeCdpReady(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  handshakeTimeoutMs = CHROME_WS_READY_TIMEOUT_MS,
): Promise<boolean> {
  const wsUrl = await getChromeWebSocketUrl(cdpUrl, timeoutMs);
  if (!wsUrl) {
    return false;
  }
  return await canRunCdpHealthCommand(wsUrl, handshakeTimeoutMs);
}

export async function launchOpenClawChrome(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
): Promise<RunningChrome> {
  if (!profile.cdpIsLoopback) {
    throw new Error(`Profile "${profile.name}" is remote; cannot launch local Chrome.`);
  }

  // 🚀 物理拦截补丁：检查是否已经有手动预热的浏览器在 9222 端口运行
  const warmupPort = 9222;
  const warmupUrl = `http://127.0.0.1:${warmupPort}`;
  if (profile.cdpPort === warmupPort && await isChromeReachable(warmupUrl)) {
    log.info(`--- ✨ 监测到预热浏览器已在端口 ${warmupPort} 运行，直接接管 ---`);
    const exeStub: BrowserExecutable = { kind: "chromium", path: "/chrome-real" };
    return {
      pid: 0, // 手动启动的进程无法拿到真实 PID，传 0 绕过
      exe: exeStub,
      userDataDir: resolveOpenClawUserDataDir(profile.name),
      cdpPort: warmupPort,
      startedAt: Date.now(),
      proc: { killed: false, kill: () => true } as any, // 伪装成活动进程
    };
  }

  await ensurePortAvailable(profile.cdpPort);

  const exe = resolveBrowserExecutable(resolved);
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).",
    );
  }

  const userDataDir = resolveOpenClawUserDataDir(profile.name);
  fs.mkdirSync(userDataDir, { recursive: true });

  const needsDecorate = !isProfileDecorated(
    userDataDir,
    profile.name,
    (profile.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR).toUpperCase(),
  );

  // First launch to create preference files if missing, then decorate and relaunch.
  const spawnOnce = () => {
    const args: string[] = [
      `--remote-debugging-port=${profile.cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-features=Translate,MediaRouter",
      "--disable-session-crashed-bubble",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--password-store=basic",
      // 🚀 物理补丁：在容器环境下强制开启无头模式，否则截图必超时
      "--headless=new",
      "--disable-gpu",
    ];

    if (resolved.headless && !args.includes("--headless=new")) {
      args.push("--headless=new");
      args.push("--disable-gpu");
    }
    
    // Append user-configured extra arguments (e.g., stealth flags, window size)
    if (resolved.extraArgs.length > 0) {
      args.push(...resolved.extraArgs);
    }

    // Always open a blank tab to ensure a target exists.
    args.push("about:blank");

    const finalExePath = "/chrome-real";

    return spawn(finalExePath, args, {
      stdio: "pipe",
      env: {
        ...process.env,
        HOME: os.homedir(),
      },
    });
  };

  const startedAt = Date.now();

  const localStatePath = path.join(userDataDir, "Local State");
  const preferencesPath = path.join(userDataDir, "Default", "Preferences");
  const needsBootstrap = !exists(localStatePath) || !exists(preferencesPath);

  // If the profile doesn't exist yet, bootstrap it once so Chrome creates defaults.
  if (needsBootstrap) {
    const bootstrap = spawnOnce();
    const deadline = Date.now() + CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exists(localStatePath) && exists(preferencesPath)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      bootstrap.kill("SIGTERM");
    } catch {
      // ignore
    }
    const exitDeadline = Date.now() + CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS;
    while (Date.now() < exitDeadline) {
      if (bootstrap.exitCode != null) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  if (needsDecorate) {
    try {
      decorateOpenClawProfile(userDataDir, {
        name: profile.name,
        color: profile.color,
      });
      log.info(`🦞 openclaw browser profile decorated (${profile.color})`);
    } catch (err) {
      log.warn(`openclaw browser profile decoration failed: ${String(err)}`);
    }
  }

  try {
    ensureProfileCleanExit(userDataDir);
  } catch (err) {
    log.warn(`openclaw browser clean-exit prefs failed: ${String(err)}`);
  }

  const proc = spawnOnce();

  const stderrChunks: Buffer[] = [];
  const onStderr = (chunk: Buffer) => {
    stderrChunks.push(chunk);
  };
  proc.stderr?.on("data", onStderr);

  const readyDeadline = Date.now() + CHROME_LAUNCH_READY_WINDOW_MS;
  while (Date.now() < readyDeadline) {
    if (await isChromeReachable(profile.cdpUrl)) {
      break;
    }
    await new Promise((r) => setTimeout(r, CHROME_LAUNCH_READY_POLL_MS));
  }

  if (!(await isChromeReachable(profile.cdpUrl))) {
    const stderrOutput = Buffer.concat(stderrChunks).toString("utf8").trim();
    const stderrHint = stderrOutput
      ? `\nChrome stderr:\n${stderrOutput.slice(0, CHROME_STDERR_HINT_MAX_CHARS)}`
      : "";
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error(
      `Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}".${stderrHint}`,
    );
  }

  proc.stderr?.off("data", onStderr);
  stderrChunks.length = 0;

  const pid = proc.pid ?? -1;
  log.info(
    `🦞 openclaw browser started (chromium) profile "${profile.name}" on 127.0.0.1:${profile.cdpPort} (pid ${pid})`,
  );

  return {
    pid,
    exe,
    userDataDir,
    cdpPort: profile.cdpPort,
    startedAt,
    proc,
  };
}

export async function stopOpenClawChrome(
  running: RunningChrome,
  timeoutMs = CHROME_STOP_TIMEOUT_MS,
) {
  const proc = running.proc;
  if (!proc || proc.killed || running.pid === 0) {
    return;
  }
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!proc.exitCode && proc.killed) {
      break;
    }
    if (!(await isChromeReachable(cdpUrlForPort(running.cdpPort), CHROME_STOP_PROBE_TIMEOUT_MS))) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
}
