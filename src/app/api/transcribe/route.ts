import { NextRequest, NextResponse } from "next/server";
import openai from "@/lib/openai";

// POST multipart/form-data with an "audio" file field.
// Returns { text: string } — the Whisper transcription.
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const audio = formData.get("audio");

    if (!audio || !(audio instanceof File)) {
      return NextResponse.json({ error: "Missing audio file" }, { status: 400 });
    }

    const transcript = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: audio,
      language: "en",
    });

    return NextResponse.json({ text: transcript.text });
  } catch (err) {
    console.error("Transcribe error:", err);
    return NextResponse.json({ error: "Transcription failed" }, { status: 500 });
  }
}
