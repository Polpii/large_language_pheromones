import { NextResponse } from "next/server";
import { getBridgeStatus } from "@/lib/scent-bridge";

/** GET — Get scent bridge status (fast, no BLE scan).
 *  Use POST /api/scent/connect to trigger a BLE device scan. */
export async function GET() {
  const bridge = await getBridgeStatus();

  if (!bridge.running) {
    return NextResponse.json({
      bridge: { running: false },
      device: { connected: false },
    });
  }

  return NextResponse.json({
    bridge: {
      running: true,
      playing: bridge.playing,
      bleak_installed: bridge.bleak_installed,
      last_error: bridge.last_error ?? "",
    },
    device: {
      connected: bridge.device_connected ?? false,
      address: bridge.device_address ?? "",
    },
  });
}
