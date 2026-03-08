import { NextResponse } from "next/server";
import { ensureBridge, checkConnection } from "@/lib/scent-bridge";

/** POST — Start bridge if needed and trigger BLE device scan */
export async function POST() {
  const started = await ensureBridge();
  if (!started) {
    return NextResponse.json({
      bridge: { running: false },
      device: { connected: false, message: "Bridge could not start" },
    });
  }

  const device = await checkConnection();

  return NextResponse.json({
    bridge: { running: true },
    device,
  });
}
