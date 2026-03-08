import { spawn, ChildProcess } from "child_process";
import path from "path";
import os from "os";

const BRIDGE_PORT = parseInt(process.env.SCENT_BRIDGE_PORT || "5050");
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;

let bridgeProcess: ChildProcess | null = null;
let bridgeReady = false;
let startingBridge = false; // mutex to prevent duplicate spawns

function getPythonCommand(): string {
  return os.platform() === "win32" ? "python" : "python3";
}

/** Start the Python BLE bridge if not already running */
export async function ensureBridge(): Promise<boolean> {
  // Fast check: already running?
  if (bridgeReady) {
    try {
      const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      bridgeReady = false;
    }
  }

  // Check if an external instance is running (e.g. user started it manually)
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      bridgeReady = true;
      return true;
    }
  } catch {
    // Not running
  }

  // Prevent concurrent spawn attempts
  if (startingBridge) {
    // Wait for the other spawn attempt to finish
    await new Promise((r) => setTimeout(r, 5000));
    return bridgeReady;
  }

  startingBridge = true;

  // Kill any existing zombie process
  if (bridgeProcess) {
    try { bridgeProcess.kill(); } catch { /* */ }
    bridgeProcess = null;
  }

  return new Promise((resolve) => {
    const scriptPath = path.join(process.cwd(), "scent-bridge", "server.py");
    const pythonCmd = getPythonCommand();
    console.log(`[scent-bridge] Starting bridge with: ${pythonCmd} ${scriptPath}`);

    bridgeProcess = spawn(pythonCmd, [scriptPath, "--port", String(BRIDGE_PORT)], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        console.error("[scent-bridge] Startup timeout after 10s");
        startingBridge = false;
        resolve(false);
      }
    }, 10000);

    bridgeProcess.stdout?.on("data", (data: Buffer) => {
      const msg = data.toString();
      console.log(msg.trim());
      if (msg.includes("Listening") && !started) {
        started = true;
        bridgeReady = true;
        startingBridge = false;
        clearTimeout(timeout);
        resolve(true);
      }
    });

    bridgeProcess.stderr?.on("data", (data: Buffer) => {
      console.error(`[scent-bridge] ${data.toString().trim()}`);
    });

    bridgeProcess.on("exit", (code) => {
      console.log(`[scent-bridge] Process exited with code ${code}`);
      bridgeReady = false;
      bridgeProcess = null;
      if (!started) {
        startingBridge = false;
        clearTimeout(timeout);
        resolve(false);
      }
    });
  });
}

/** Check BLE device connection status (triggers BLE scan — use sparingly) */
export async function checkConnection(): Promise<{ connected: boolean; address?: string; message?: string }> {
  try {
    const res = await fetch(`${BRIDGE_URL}/connect`, { signal: AbortSignal.timeout(20000) });
    return await res.json();
  } catch (e) {
    return { connected: false, message: e instanceof Error ? e.message : "Bridge not running" };
  }
}

/** Play a sequence of scents on the device */
export async function playSequence(
  sequence: Array<{ scent_id: number; duration: number }>
): Promise<{ status: string; message: string }> {
  try {
    const res = await fetch(`${BRIDGE_URL}/play`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sequence }),
      signal: AbortSignal.timeout(120000),
    });
    return await res.json();
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : "Failed to play" };
  }
}

/** Stop the currently playing sequence */
export async function stopPlayback(): Promise<{ status: string; message: string }> {
  try {
    const res = await fetch(`${BRIDGE_URL}/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    return await res.json();
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : "Failed to stop" };
  }
}

/** Get bridge health status — fast, no BLE scan */
export async function getBridgeStatus(): Promise<{
  running: boolean;
  playing?: boolean;
  device_connected?: boolean;
  device_address?: string;
  bleak_installed?: boolean;
  last_error?: string;
}> {
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      return {
        running: true,
        playing: data.playing,
        device_connected: data.device_connected,
        device_address: data.device_address,
        bleak_installed: data.bleak_installed,
        last_error: data.last_error,
      };
    }
  } catch { /* */ }
  return { running: false };
}
