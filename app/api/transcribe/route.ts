import { randomUUID } from "crypto";
import OpenAI from "openai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type TimedSegment = {
  start: number;
  end: number;
  text: string;
};

type TimedWord = {
  start: number;
  end: number;
  word: string;
};

const parseSegments = (transcription: unknown): TimedSegment[] => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const verbose = transcription as any;
  if (!Array.isArray(verbose?.segments)) return [];

  return (verbose.segments as Array<{ start?: number; end?: number; text?: string }>)
    .map((item) => ({
      start: Number(item.start ?? 0),
      end: Number(item.end ?? 0),
      text: String(item.text ?? "").trim(),
    }))
    .filter((item) => item.text.length > 0 && item.end > item.start);
};

const parseWords = (transcription: unknown): TimedWord[] => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const verbose = transcription as any;
  if (!Array.isArray(verbose?.words)) return [];

  return (verbose.words as Array<{ start?: number; end?: number; word?: string }>)
    .map((item) => ({
      start: Number(item.start ?? 0),
      end: Number(item.end ?? 0),
      word: String(item.word ?? "").trim(),
    }))
    .filter((item) => item.word.length > 0 && item.end > item.start);
};

export async function POST(request: Request) {
  const requestId = randomUUID().slice(0, 8);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "missing OPENAI_API_KEY in your environment" },
      {
        status: 500,
        headers: {
          "x-transcribe-request-id": requestId,
        },
      },
    );
  }

  const formData = await request.formData();
  const audio = formData.get("audio");
  if (!(audio instanceof File)) {
    return NextResponse.json(
      { error: "upload an audio file first" },
      {
        status: 400,
        headers: {
          "x-transcribe-request-id": requestId,
        },
      },
    );
  }

  try {
    const client = new OpenAI({ apiKey });
    let transcription: Awaited<ReturnType<typeof client.audio.transcriptions.create>>;

    try {
      transcription = await client.audio.transcriptions.create({
        file: audio,
        model: "whisper-1",
        response_format: "verbose_json",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        timestamp_granularities: ["segment", "word"] as any,
      });
    } catch {
      transcription = await client.audio.transcriptions.create({
        file: audio,
        model: "whisper-1",
      });
    }

    const text = transcription.text ?? "";
    const segments = parseSegments(transcription);
    const words = parseWords(transcription);

    return NextResponse.json(
      {
        text,
        segments,
        words,
        alignment: "whisper",
      },
      {
        headers: {
          "x-transcribe-request-id": requestId,
        },
      },
    );
  } catch {
    return NextResponse.json(
      { error: "transcription request failed" },
      {
        status: 500,
        headers: {
          "x-transcribe-request-id": requestId,
        },
      },
    );
  }
}
