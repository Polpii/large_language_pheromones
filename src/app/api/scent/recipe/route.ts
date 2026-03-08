import { NextRequest, NextResponse } from "next/server";
import { generateRecipe, getRecipe, getAllRecipes } from "@/lib/scent";

/** POST — Generate a scent recipe for a user (from their profile) */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await req.json();
    if (!userId) {
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }
    const recipe = await generateRecipe(userId);
    return NextResponse.json({ recipe });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Recipe generation failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** GET — Get a user's recipe or list all recipes */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId");
  if (userId) {
    const recipe = await getRecipe(userId);
    if (!recipe) {
      return NextResponse.json({ error: "No recipe found" }, { status: 404 });
    }
    return NextResponse.json({ recipe });
  }
  const recipes = await getAllRecipes();
  return NextResponse.json({ recipes });
}
