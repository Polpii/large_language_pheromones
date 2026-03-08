import { NextRequest, NextResponse } from "next/server";
import { getProfile } from "@/lib/profiles";
import { getActivities } from "@/lib/activity";
import fs from "fs/promises";
import path from "path";

const STATES_FILE = path.join(process.cwd(), "data", "user-states.json");

async function readStates(): Promise<Record<string, { state: string; ts: number }>> {
  try {
    const content = await fs.readFile(STATES_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function writeStates(states: Record<string, { state: string; ts: number }>) {
  await fs.mkdir(path.dirname(STATES_FILE), { recursive: true });
  await fs.writeFile(STATES_FILE, JSON.stringify(states, null, 2));
}

// POST: Web frontend pushes its current UI state
export async function POST(req: NextRequest) {
  const { deviceId, state } = await req.json();
  if (!deviceId || !state) {
    return NextResponse.json({ error: "Missing deviceId or state" }, { status: 400 });
  }
  const states = await readStates();
  states[deviceId] = { state, ts: Date.now() };
  await writeStates(states);
  return NextResponse.json({ ok: true });
}

// GET: Pi client polls for the current state
export async function GET(req: NextRequest) {
  const deviceId = req.nextUrl.searchParams.get("deviceId");
  if (!deviceId) {
    return NextResponse.json({ error: "Missing deviceId" }, { status: 400 });
  }

  const profile = await getProfile(deviceId);
  if (!profile) {
    return NextResponse.json({ error: "No profile" }, { status: 404 });
  }

  // Check UI state pushed from the web frontend
  const states = await readStates();
  const uiState = states[deviceId];
  // If the web pushed a state recently (within 30s), use it
  const uiFresh = uiState && (Date.now() - uiState.ts < 30000);

  // Also check activity system for dating
  const activities = await getActivities();
  const myActivity = activities.find((a) => a.requesterId === deviceId);
  const beingTargeted = activities.some((a) => a.currentTargetId === deviceId);

  let state: string;
  let targetId: string | null = null;

  // UI state from the web takes priority if fresh
  if (uiFresh && uiState.state !== "idle") {
    state = uiState.state;
  } else if (myActivity?.currentTargetId) {
    state = "dating";
    targetId = myActivity.currentTargetId;
  } else if (beingTargeted) {
    state = "interact";
  } else if (uiFresh) {
    state = uiState.state;
  } else {
    state = "idle";
  }

  return NextResponse.json({
    userId: deviceId,
    state,
    targetId,
    phase: myActivity?.phase || null,
    completedTargets: myActivity?.completedTargets || [],
    totalTargets: myActivity?.targetQueue?.length || 0,
  });
}
