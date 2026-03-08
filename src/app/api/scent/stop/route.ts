import { NextResponse } from "next/server";
import { stopPlayback } from "@/lib/scent-bridge";

/** POST — Stop the currently playing scent sequence */
export async function POST() {
  const result = await stopPlayback();
  return NextResponse.json(result);
}
