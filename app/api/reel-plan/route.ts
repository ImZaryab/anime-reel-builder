import OpenAI from "openai";
import { NextResponse } from "next/server";

type PlanRequest = {
  coreIdea?: string;
  transcript?: string;
};

const fallbackPlan = (coreIdea: string, transcript: string): string => {
  const seed = `${coreIdea} ${transcript}`.toLowerCase();
  const mood = /pain|struggle|dark|alone|fight|loss/.test(seed)
    ? "intense training, setbacks, and comeback moments"
    : /patience|calm|peace|focus|discipline/.test(seed)
      ? "calm focus shots, introspective walk cycles, and quiet determination scenes"
      : "high-conviction transformation scenes and momentum-building action beats";

  return [
    "Clip Direction:",
    `Use anime scenes with ${mood}.`,
    "Mix close-up emotion beats with medium action beats for pacing.",
    "Cohesion Signs:",
    "Repeat visual motifs: clenched fists, eyes locking in, sunrise/sunset transitions, and forward motion.",
    "Use escalating intensity every 2-3 clips to mirror the spoken message arc.",
  ].join(" ");
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as PlanRequest;
    const coreIdea = body.coreIdea?.trim() ?? "";
    const transcript = body.transcript?.trim() ?? "";

    if (!coreIdea || !transcript) {
      return NextResponse.json(
        { error: "coreIdea and transcript are required" },
        { status: 400 },
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ strategy: fallbackPlan(coreIdea, transcript) });
    }

    const client = new OpenAI({ apiKey });
    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content:
            "You are a reel creative director. Return concise direction for sourcing anime clips. Include: mood/sentiment targets, clip types to prioritize, and recurring visual signs for cohesion.",
        },
        {
          role: "user",
          content: `Core idea: ${coreIdea}\nVoiceover transcript: ${transcript}\nGoal: create a viral motivational reel using clips from different anime while preserving message cohesion.`,
        },
      ],
      max_output_tokens: 380,
    });

    const strategy = response.output_text?.trim();
    if (!strategy) {
      return NextResponse.json({ strategy: fallbackPlan(coreIdea, transcript) });
    }

    return NextResponse.json({ strategy });
  } catch {
    return NextResponse.json(
      { error: "could not create reel strategy right now" },
      { status: 500 },
    );
  }
}
