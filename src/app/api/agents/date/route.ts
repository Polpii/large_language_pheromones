import { NextRequest, NextResponse } from "next/server";
import openai from "@/lib/openai";
import { getProfile, getAllProfiles } from "@/lib/profiles";
import {
  saveConversation,
  type Conversation,
  type ConversationMessage,
} from "@/lib/conversations";
import { upsertActivity, removeActivity, type DatingActivity } from "@/lib/activity";
import { getRecipe, recipeToPlaySequence } from "@/lib/scent";
import { ensureBridge, playSequence } from "@/lib/scent-bridge";

const MODEL = () => process.env.OPENAI_MODEL || "gpt-4o";

async function agentDate(
  profileA: Record<string, unknown>,
  profileB: Record<string, unknown>,
  idA: string,
  idB: string,
  query: string
): Promise<{
  messages: ConversationMessage[];
  score: number;
  summary: string;
  compatibility: Record<string, number>;
}> {
  const messages: ConversationMessage[] = [];
  const chatA: { role: "system" | "user" | "assistant"; content: string }[] = [
    {
      role: "system",
      content: `You are Agent ${idA}, representing your human. Your human's profile:\n${JSON.stringify(profileA, null, 2)}\n\nYou're on a date with Agent ${idB}. Your human is looking for: ${query}\n\nBe natural, ask questions, share about your human. Keep each message 2-3 sentences max.`,
    },
  ];
  const chatB: { role: "system" | "user" | "assistant"; content: string }[] = [
    {
      role: "system",
      content: `You are Agent ${idB}, representing your human. Your human's profile:\n${JSON.stringify(profileB, null, 2)}\n\nYou're on a date with Agent ${idA}. Be natural, honest about your human's strengths and weaknesses. Keep each message 2-3 sentences max.`,
    },
  ];

  // 5 turns of conversation (10 messages total)
  for (let turn = 0; turn < 5; turn++) {
    // Agent A speaks
    const replyA = await openai.chat.completions.create({
      model: MODEL(),
      messages: chatA,
      max_tokens: 150,
      temperature: 0.8,
    });
    const textA = replyA.choices[0]?.message?.content || "";
    const now = new Date().toISOString();
    messages.push({
      from: `agent-${idA}`,
      to: `agent-${idB}`,
      content: textA,
      timestamp: now,
    });
    chatA.push({ role: "assistant", content: textA });
    chatB.push({ role: "user", content: textA });

    // Agent B responds
    const replyB = await openai.chat.completions.create({
      model: MODEL(),
      messages: chatB,
      max_tokens: 150,
      temperature: 0.8,
    });
    const textB = replyB.choices[0]?.message?.content || "";
    const now2 = new Date().toISOString();
    messages.push({
      from: `agent-${idB}`,
      to: `agent-${idA}`,
      content: textB,
      timestamp: now2,
    });
    chatB.push({ role: "assistant", content: textB });
    chatA.push({ role: "user", content: textB });
  }

  // Assessment
  const assessment = await openai.chat.completions.create({
    model: MODEL(),
    messages: [
      {
        role: "system",
        content: `You are a BRUTALLY HONEST compatibility assessor. Be realistic and critical.

Profile A (User ${idA}):\n${JSON.stringify(profileA, null, 2)}
Profile B (User ${idB}):\n${JSON.stringify(profileB, null, 2)}
Looking for: ${query}

Conversation:\n${messages.map((m) => `${m.from}: ${m.content}`).join("\n")}

IMPORTANT SCORING RULES:
- Do NOT be generous. Most random pairs of people are NOT highly compatible.
- Score 80-100: Exceptional match, rare. Deep alignment on values, goals AND interests.
- Score 60-79: Good potential, some shared ground but notable differences.
- Score 40-59: Mediocre. Some common ground but fundamental mismatches.
- Score 20-39: Poor match. Very different people with little overlap.
- Score 0-19: Terrible match. Opposing values, no chemistry, nothing in common.
- The AVERAGE score should be around 40-50. High scores (70+) should be RARE.
- If their lifestyles, ages, interests, or goals are very different, score LOW.
- A friendly conversation does NOT mean high compatibility.

Respond with ONLY valid JSON:
{"score": 0-100, "summary": "2 sentence assessment - be honest about mismatches", "compatibility": {"interests": 0-100, "goals": 0-100, "personality": 0-100, "lifestyle": 0-100}}`,
      },
    ],
    max_tokens: 300,
  });

  let score = 50;
  let summary = "Assessment inconclusive.";
  let compatibility: Record<string, number> = {};

  try {
    const jsonMatch = (assessment.choices[0]?.message?.content || "").match(
      /\{[\s\S]*\}/
    );
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      score = parsed.score ?? 50;
      summary = parsed.summary ?? summary;
      compatibility = parsed.compatibility ?? {};
    }
  } catch {
    // fallback
  }

  return { messages, score, summary, compatibility };
}

export async function POST(req: NextRequest) {
  try {
    const { deviceId, query } = await req.json();
    if (!deviceId || !query) {
      return NextResponse.json(
        { error: "Missing deviceId or query" },
        { status: 400 }
      );
    }

    const userProfile = await getProfile(deviceId);
    if (!userProfile) {
      return NextResponse.json(
        { error: "No profile found" },
        { status: 404 }
      );
    }

    const allProfiles = await getAllProfiles();
    const otherProfiles = allProfiles.filter((p) => {
      const meta = p.metadata as Record<string, unknown> | undefined;
      const sid = meta?.subject_id as string | undefined;
      // Exclude the requesting user's own profile
      return sid !== deviceId;
    });

    if (otherProfiles.length === 0) {
      return NextResponse.json({
        matches: [],
        summary: "No other profiles yet.",
      });
    }

    // Date ALL other users — no screening, talk to everyone
    const targetIds: string[] = otherProfiles.map((p) => {
      const meta = p.metadata as Record<string, unknown> | undefined;
      return (meta?.subject_id as string) || "?";
    });

    const activity: DatingActivity = {
      type: "dating",
      requesterId: deviceId,
      currentTargetId: null,
      phase: "dating",
      targetQueue: targetIds,
      completedTargets: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await upsertActivity(activity);

    const matches = [];
    for (let idx = 0; idx < otherProfiles.length; idx++) {
      const otherProfile = otherProfiles[idx];
      const otherMeta = otherProfile.metadata as Record<string, unknown> | undefined;
      const otherId = (otherMeta?.subject_id as string) || `${idx + 1}`;

      // Update activity: moving to this target
      activity.currentTargetId = otherId;
      activity.updatedAt = new Date().toISOString();
      await upsertActivity(activity);

      const dateResult = await agentDate(
        userProfile,
        otherProfile,
        deviceId,
        otherId,
        query
      );

      // Save conversation
      const convId = `date-${deviceId}-${otherId}-${Date.now()}`;
      const conversation: Conversation = {
        id: convId,
        agentA: deviceId,
        agentB: otherId,
        query,
        requestedBy: deviceId,
        messages: dateResult.messages,
        result: {
          score: dateResult.score,
          summary: dateResult.summary,
          compatibility: dateResult.compatibility,
        },
        createdAt: new Date().toISOString(),
      };
      await saveConversation(conversation);

      // Update activity: done with this target
      activity.completedTargets.push(otherId);
      activity.currentTargetId = null;
      activity.updatedAt = new Date().toISOString();
      await upsertActivity(activity);

      matches.push({
        profileId: otherId,
        name: `User ${otherId}`,
        score: dateResult.score,
        reason: dateResult.summary,
        compatibility: dateResult.compatibility,
        conversationId: convId,
      });
    }

    matches.sort((a, b) => b.score - a.score);

    // 🧪 PHEROMONES: Play the best match's scent recipe on the device
    if (matches.length > 0) {
      const bestMatch = matches[0];
      console.log(`[pheromones] Best match: ${bestMatch.profileId} (score: ${bestMatch.score})`);
      const recipe = await getRecipe(bestMatch.profileId);
      if (recipe) {
        const sequence = recipeToPlaySequence(recipe);
        if (sequence.length > 0) {
          // Start bridge + play in background
          ensureBridge().then(async (ok) => {
            if (ok) {
              console.log(`[pheromones] Playing scent recipe for match ${bestMatch.profileId}...`);
              const result = await playSequence(sequence);
              console.log(`[pheromones] Play result: ${result.message}`);
            } else {
              console.warn("[pheromones] Bridge not available, skipping scent playback");
            }
          });
        }
      } else {
        console.log(`[pheromones] No recipe found for ${bestMatch.profileId}`);
      }
    }

    // Remove activity when done
    await removeActivity(deviceId);

    return NextResponse.json({
      matches,
      summary:
        matches.length > 0
          ? `Found ${matches.length} match${matches.length > 1 ? "es" : ""}!`
          : "No good matches found.",
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Dating failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
