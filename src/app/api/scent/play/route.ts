import { NextRequest, NextResponse } from "next/server";
import { getRecipe, recipeToPlaySequence } from "@/lib/scent";
import { ensureBridge, playSequence } from "@/lib/scent-bridge";

/** POST — Play a user's scent recipe on the device */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await req.json();
    if (!userId) {
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }

    const recipe = await getRecipe(userId);
    if (!recipe) {
      return NextResponse.json({ error: `No recipe for ${userId}` }, { status: 404 });
    }

    // Ensure the BLE bridge is running
    const bridgeOk = await ensureBridge();
    if (!bridgeOk) {
      return NextResponse.json(
        { error: "Scent bridge not available. Make sure Python + bleak are installed." },
        { status: 503 }
      );
    }

    const sequence = recipeToPlaySequence(recipe);
    if (sequence.length === 0) {
      return NextResponse.json({ error: "Recipe has no playable scents" }, { status: 400 });
    }

    // Send to bridge — bridge returns immediately, plays in background
    const result = await playSequence(sequence);
    console.log(`[pheromones] Play request for ${userId}:`, result.message);

    return NextResponse.json({
      status: result.status === "error" ? "error" : "playing",
      userId,
      sequence,
      totalDuration: sequence.reduce((s, i) => s + i.duration, 0),
      ...(result.status === "error" ? { error: result.message } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Play failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
