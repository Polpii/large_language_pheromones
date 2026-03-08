import fs from "fs/promises";
import path from "path";
import openai from "@/lib/openai";
import { getProfile } from "@/lib/profiles";

const RECIPES_DIR = path.join(process.cwd(), "data", "recipes");
const MODEL = () => process.env.OPENAI_MODEL || "gpt-4o";

async function ensureDir() {
  await fs.mkdir(RECIPES_DIR, { recursive: true });
}

// ---------- Scent classification (locations 1-12 are on the physical device) ----------

export const SCENT_CLASSIFICATION: Record<
  string,
  { joy: number; fear: number; sadness: number; disgust: number; trust: number; anxiety: number; anticipation: number; surprise: number; location: string }
> = {
  "geosmin 1%":       { joy: 1, fear: 3, sadness: 2, disgust: 2, trust: 5, anxiety: 2, anticipation: 1, surprise: 4, location: "1" },
  "garlic":           { joy: 1, fear: 3, sadness: 2, disgust: 6, trust: 5, anxiety: 5, anticipation: 1, surprise: 6, location: "2" },
  "sage":             { joy: 1, fear: 1, sadness: 6, disgust: 1, trust: 4, anxiety: 6, anticipation: 1, surprise: 3, location: "3" },
  "patchouli":        { joy: 1, fear: 5, sadness: 3, disgust: 5, trust: 5, anxiety: 2, anticipation: 1, surprise: 1, location: "4" },
  "lavanda ess france": { joy: 2, fear: 2, sadness: 5, disgust: 3, trust: 6, anxiety: 2, anticipation: 5, surprise: 5, location: "5" },
  "oregano":          { joy: 2, fear: 6, sadness: 2, disgust: 6, trust: 1, anxiety: 7, anticipation: 1, surprise: 3, location: "6" },
  "myrth":            { joy: 3, fear: 3, sadness: 4, disgust: 5, trust: 4, anxiety: 5, anticipation: 1, surprise: 4, location: "7" },
  "holy basil":       { joy: 5, fear: 6, sadness: 1, disgust: 5, trust: 1, anxiety: 2, anticipation: 1, surprise: 3, location: "8" },
  "tangerine":        { joy: 5, fear: 3, sadness: 5, disgust: 6, trust: 4, anxiety: 4, anticipation: 3, surprise: 5, location: "9" },
  "whisper bond":     { joy: 6, fear: 6, sadness: 2, disgust: 6, trust: 2, anxiety: 6, anticipation: 1, surprise: 3, location: "10" },
  "serene embrace":   { joy: 7, fear: 5, sadness: 4, disgust: 4, trust: 2, anxiety: 5, anticipation: 4, surprise: 5, location: "11" },
  "strawberry":       { joy: 7, fear: 5, sadness: 4, disgust: 6, trust: 5, anxiety: 4, anticipation: 2, surprise: 5, location: "12" },
};

// ---------- Recipe types ----------

export interface ScentItem {
  scent_name: string;
  scent_duration: number;
}

export interface ScentRecipe {
  userId: string;
  description: string;
  scent_sequence: ScentItem[];
  justification: string;
  createdAt: string;
}

// ---------- Recipe CRUD ----------

export async function saveRecipe(userId: string, recipe: ScentRecipe): Promise<void> {
  await ensureDir();
  const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId) throw new Error("Invalid user ID");
  await fs.writeFile(path.join(RECIPES_DIR, `${safeId}.json`), JSON.stringify(recipe, null, 2));
}

export async function getRecipe(userId: string): Promise<ScentRecipe | null> {
  await ensureDir();
  const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId) return null;
  try {
    const content = await fs.readFile(path.join(RECIPES_DIR, `${safeId}.json`), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function getAllRecipes(): Promise<ScentRecipe[]> {
  await ensureDir();
  const files = await fs.readdir(RECIPES_DIR);
  const recipes: ScentRecipe[] = [];
  for (const f of files) {
    if (f.endsWith(".json")) {
      try {
        const content = await fs.readFile(path.join(RECIPES_DIR, f), "utf-8");
        recipes.push(JSON.parse(content));
      } catch { /* skip */ }
    }
  }
  return recipes;
}

// ---------- Build a description sentence from a profile ----------

function profileToDescription(profile: Record<string, unknown>): string {
  const parts: string[] = [];
  const meta = profile.metadata as Record<string, unknown> | undefined;
  if (meta) {
    if (meta.subject_id) parts.push(`Name: ${meta.subject_id}`);
    if (meta.chronological_age) parts.push(`Age: ${meta.chronological_age}`);
    if (meta.life_stage) parts.push(`Life stage: ${meta.life_stage}`);
  }
  const spatial = profile.spatial_timeline as Array<Record<string, unknown>> | undefined;
  if (spatial?.length) {
    const places = spatial.map((s) => `${s.location} (${s.attribute})`).join(", ");
    parts.push(`Places: ${places}`);
  }
  const projects = profile.active_projects as Array<Record<string, unknown>> | undefined;
  if (projects?.length) {
    parts.push(`Projects: ${projects.map((p) => p.title).join(", ")}`);
  }
  const media = profile.recent_media as Record<string, unknown> | undefined;
  if (media) {
    const items: string[] = [];
    for (const [k, v] of Object.entries(media)) {
      if (Array.isArray(v) && v.length) items.push(`${k}: ${v.join(", ")}`);
    }
    if (items.length) parts.push(`Media: ${items.join("; ")}`);
  }
  const focus = profile.focus_areas as Record<string, unknown> | undefined;
  if (focus) {
    const items: string[] = [];
    for (const [k, v] of Object.entries(focus)) {
      if (Array.isArray(v) && v.length) items.push(`${k}: ${v.join(", ")}`);
    }
    if (items.length) parts.push(`Interests: ${items.join("; ")}`);
  }
  const goals = profile.goals as Record<string, unknown> | undefined;
  if (goals) {
    if (goals.vision) parts.push(`Vision: ${goals.vision}`);
    if (Array.isArray(goals.seeking) && goals.seeking.length) parts.push(`Seeking: ${goals.seeking.join(", ")}`);
  }
  const movies = profile.favorite_movies as string[] | undefined;
  if (movies?.length) parts.push(`Favorite movies: ${movies.join(", ")}`);
  const travel = profile.recent_travel as Array<Record<string, unknown>> | undefined;
  if (travel?.length) parts.push(`Recent travel: ${travel.map((t) => t.location).join(", ")}`);

  return parts.join(". ") || `A person named ${meta?.subject_id || "unknown"}`;
}

// ---------- Normalize scent names ----------

function normalizeSequence(sequence: ScentItem[]): ScentItem[] {
  const lowerMap: Record<string, string> = {};
  for (const k of Object.keys(SCENT_CLASSIFICATION)) {
    lowerMap[k.toLowerCase()] = k;
  }
  return sequence.map((item) => {
    const canonical = lowerMap[item.scent_name.toLowerCase()];
    if (canonical) return { scent_name: canonical, scent_duration: item.scent_duration };
    // Fuzzy: prefix match
    const key = Object.keys(lowerMap).find(
      (lo) => lo.startsWith(item.scent_name.toLowerCase()) || item.scent_name.toLowerCase().startsWith(lo)
    );
    if (key) return { scent_name: lowerMap[key], scent_duration: item.scent_duration };
    return item;
  });
}

// ---------- Generate recipe from profile via OpenAI ----------

const SYSTEM_PROMPT = `You are 'Etherea,' a specialized Scent Composer AI. Your purpose is to translate a person's description into a 60-second olfactory experience using a specific scent palette.

Your response must be a single valid JSON object, no markdown.

SCENT PALETTE (with emotional attributes, scale 1-7):
${JSON.stringify(SCENT_CLASSIFICATION, null, 2)}

RULES:
1. Create a narrative arc: Opening (0-15s), Heart (15-45s), Closing (45-60s).
2. Total duration must equal EXACTLY 60 seconds.
3. Each scent_duration: integer 1-30.
4. Use ONLY scent names from the palette above (exact match).
5. Match scents to the person's personality, interests, places, and emotional profile.
6. Default: 6 scents × 10s each if uncertain.

OUTPUT FORMAT:
{"scent_sequence": [{"scent_name": "...", "scent_duration": N}, ...], "justification": "..."}`;

export async function generateRecipe(userId: string): Promise<ScentRecipe> {
  const profile = await getProfile(userId);
  if (!profile) throw new Error(`No profile for ${userId}`);

  const description = profileToDescription(profile);

  const response = await openai.chat.completions.create({
    model: MODEL(),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Create a scent experience for this person:\n\n${description}` },
    ],
    max_tokens: 800,
    temperature: 0.8,
  });

  const raw = response.choices[0]?.message?.content || "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Failed to generate recipe: no JSON in response");

  const parsed = JSON.parse(jsonMatch[0]);
  const sequence = normalizeSequence(parsed.scent_sequence || []);

  // Filter to only scents with valid locations (1-12)
  const validSequence = sequence.filter((item) => {
    const info = SCENT_CLASSIFICATION[item.scent_name];
    return info && parseInt(info.location) <= 12;
  });

  const recipe: ScentRecipe = {
    userId,
    description,
    scent_sequence: validSequence,
    justification: parsed.justification || "",
    createdAt: new Date().toISOString(),
  };

  await saveRecipe(userId, recipe);
  return recipe;
}

// ---------- Convert recipe to BLE play sequence ----------

const MAX_TOTAL_DURATION = 30; // seconds

export function recipeToPlaySequence(recipe: ScentRecipe): Array<{ scent_id: number; duration: number }> {
  const raw = recipe.scent_sequence
    .map((item) => {
      const info = SCENT_CLASSIFICATION[item.scent_name];
      if (!info) return null;
      const loc = parseInt(info.location);
      if (isNaN(loc) || loc < 1 || loc > 12) return null;
      return { scent_id: loc, duration: item.scent_duration };
    })
    .filter((x): x is { scent_id: number; duration: number } => x !== null);

  // Cap total duration to MAX_TOTAL_DURATION, scale proportionally
  const total = raw.reduce((s, i) => s + i.duration, 0);
  if (total > MAX_TOTAL_DURATION && total > 0) {
    const scale = MAX_TOTAL_DURATION / total;
    return raw.map((item) => ({
      scent_id: item.scent_id,
      duration: Math.max(1, Math.round(item.duration * scale)),
    }));
  }
  return raw;
}
