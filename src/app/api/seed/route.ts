import { NextResponse } from "next/server";
import openai from "@/lib/openai";
import { saveProfile, getAllProfiles } from "@/lib/profiles";
import { generateRecipe } from "@/lib/scent";

const FIRST_NAMES = [
  "Jake", "Emma", "Jordan", "Sophia", "Marcus", "Priya", "Tyler", "Chloe",
  "Brandon", "Mia", "Liam", "Zara", "Felix", "Luna", "Oscar", "Ivy",
  "Hugo", "Nora", "Kai", "Ada", "Leo", "Elise", "Ravi", "Suki",
  "Dante", "Freya", "Axel", "Iris", "Samir", "Yuki", "Théo", "Anya",
  "Diego", "Mei", "Jasper", "Leïla", "Finn", "Rosa", "Soren", "Amara",
];

export async function POST() {
  try {
    // Pick a name not already taken
    const existing = await getAllProfiles();
    const usedIds = new Set(
      existing.map((p) => {
        const meta = p.metadata as Record<string, unknown> | undefined;
        return (meta?.subject_id as string) || "";
      })
    );
    const available = FIRST_NAMES.filter((n) => !usedIds.has(n));
    const userId = available.length > 0
      ? available[Math.floor(Math.random() * available.length)]
      : `User-${Date.now().toString(36)}`;

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o",
      messages: [
        {
          role: "system",
          content: `Invent a completely unique, realistic fictional person named ${userId}. Pick a random age (18-45), random gender, random city in the world, random occupation, random hobbies (some niche, some mainstream), random personality traits. Make them feel like a REAL specific person, not a generic profile. Be creative and varied.

Create a complete JSON profile with ALL these fields populated with realistic data:
{
  "sharinginstructions": {
    "version": "1.9",
    "protocol": {
      "sharing_logic": "Conservative; high-signal focus.",
      "vulnerability_threshold": "Low; protect themes of [relevant theme].",
      "data_redaction": ["Redact sensitive info", "Obfuscate exact location", "Verify professional for projects"]
    }
  },
  "metadata": {
    "subject_id": "${userId}",
    "chronological_age": "[age]",
    "life_stage": "[stage]",
    "last_sync": "2026-03-07"
  },
  "spatial_timeline": [
    {"period": "[years]", "location": "[place]", "attribute": "[type]"}
  ],
  "active_projects": [
    {"title": "[project]", "objective": "[goal]", "tech": [], "collabs": []}
  ],
  "recent_media": {
    "reading": [],
    "watching": [],
    "gaming": [],
    "trading": []
  },
  "favorite_movies": [],
  "recent_travel": [
    {"location": "[place]", "date": "[date]", "type": "[type]"}
  ],
  "focus_areas": {
    "intellectual": [],
    "aesthetic": [],
    "crafts": []
  },
  "goals": {
    "vision": "[vision]",
    "growth_areas": "[growth]",
    "seeking": []
  }
}

Respond with ONLY the JSON. Make it realistic and detailed.`,
          },
        ],
        temperature: 0.9,
        max_tokens: 1500,
      });

      const reply = completion.choices[0]?.message?.content || "";
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const profile = JSON.parse(jsonMatch[0]);
          profile.metadata = profile.metadata || {};
          profile.metadata.subject_id = userId;
          profile.metadata.last_sync = new Date().toISOString().split("T")[0];
          await saveProfile(userId, profile);

          // Generate scent recipe in background (don't block response)
          generateRecipe(userId).then((recipe) => {
            console.log(`[pheromones] Recipe generated for ${userId}: ${recipe.scent_sequence.length} scents`);
          }).catch((err) => {
            console.error(`[pheromones] Failed to generate recipe for ${userId}:`, err);
          });

          return NextResponse.json({ message: `Created ${userId}`, id: userId, status: "created" });
        } catch {
          return NextResponse.json({ error: "Failed to parse profile" }, { status: 500 });
        }
      } else {
        return NextResponse.json({ error: "No profile generated" }, { status: 500 });
      }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Creation failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
