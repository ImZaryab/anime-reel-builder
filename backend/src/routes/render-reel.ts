import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { ffmpeg, ffmpegPathUsed, ffprobePathUsed } from "../lib/binaries";
import { logger } from "../lib/logger";

type ExportCaptionBlock = {
  text: string;
  start: string;
  end: string;
};

type CaptionExportOptions = {
  position: string;
  style: string;
  animated: boolean;
  offsetSeconds: number;
};

class ReelRenderError extends Error {
  stage: "mobile-fit" | "caption-burn" | "audio-mix";
  stderrTail: string[];

  constructor(
    stage: "mobile-fit" | "caption-burn" | "audio-mix",
    message: string,
    stderrTail?: string[],
  ) {
    super(message);
    this.name = "ReelRenderError";
    this.stage = stage;
    this.stderrTail = stderrTail ?? [];
  }
}

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1024 * 1024 * 512,
  },
});

const renderMemorySnapshot = () => {
  const usage = process.memoryUsage();
  return {
    rssMb: Math.round(usage.rss / 1024 / 1024),
    heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
    externalMb: Math.round(usage.external / 1024 / 1024),
  };
};

const renderTrace = (
  level: "info" | "warn" | "error",
  requestId: string,
  event: string,
  payload?: Record<string, unknown>,
) => {
  logger[level](event, {
    scope: "render-reel",
    requestId,
    memory: renderMemorySnapshot(),
    ...(payload ?? {}),
  });
};

const getTextField = (value: unknown, fallback = ""): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return fallback;
};

const hasAudioStream = (inputPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    ffmpeg.ffprobe(inputPath, (error, metadata) => {
      if (error) {
        resolve(false);
        return;
      }
      resolve((metadata.streams ?? []).some((stream) => stream.codec_type === "audio"));
    });
  });

const parseTimestampToSeconds = (value: string): number => {
  const cleaned = String(value ?? "").trim();
  if (!cleaned) return 0;

  const parts = cleaned.split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return 0;

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return hours * 3600 + minutes * 60 + seconds;
  }

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return minutes * 60 + seconds;
  }

  return parts[0] ?? 0;
};

const parseCaptions = (raw: unknown): ExportCaptionBlock[] => {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const candidate = item as Partial<ExportCaptionBlock> | null;
        return {
          text: String(candidate?.text ?? "").replace(/\s+/g, " ").trim(),
          start: String(candidate?.start ?? "").trim(),
          end: String(candidate?.end ?? "").trim(),
        };
      })
      .filter(
        (item) =>
          item.text.length > 0 &&
          item.text.length <= 220 &&
          item.start.length > 0 &&
          item.end.length > 0,
      )
      .slice(0, 160);
  } catch {
    return [];
  }
};

const escapeDrawtext = (value: string): string =>
  value
    .replace(/[\u2018\u2019]/g, "’")
    .replace(/['`"]/g, "’")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/%/g, "\\%")
    .replace(/\t/g, " ");

const escapeFilterExpression = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/:/g, "\\:");

const getCaptionPosition = (position: string): { x: string; y: string } => {
  if (position === "top-center") {
    return { x: "(w-text_w)/2", y: "h*0.10" };
  }
  if (position === "middle-center") {
    return { x: "(w-text_w)/2", y: "(h-text_h)/2" };
  }
  return { x: "(w-text_w)/2", y: "h-(text_h*2.1)" };
};

type CaptionLayer = {
  fontSize: string;
  fontColor: string;
  borderW: number;
  borderColor: string;
  box: boolean;
  boxColor?: string;
  boxBorderW?: number;
  lineSpacing: number;
  shadowColor?: string;
  shadowX?: number;
  shadowY?: number;
  alphaMultiplier?: number;
};

type CaptionStyleConfig = {
  uppercase: boolean;
  maxCharsPerLine: number;
  maxLines: number;
  layers: CaptionLayer[];
};

const wrapCaptionLines = (
  text: string,
  maxCharsPerLine: number,
  maxLines: number,
): string[] => {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [];
  if (maxCharsPerLine < 8) return [words.join(" ")];

  const lines: string[] = [];
  let currentWords: string[] = [];

  for (const word of words) {
    if (!currentWords.length) {
      currentWords = [word];
      continue;
    }

    const candidate = [...currentWords, word].join(" ");
    if (candidate.length <= maxCharsPerLine) {
      currentWords.push(word);
      continue;
    }

    lines.push(currentWords.join(" "));
    currentWords = [word];
  }

  if (currentWords.length) {
    lines.push(currentWords.join(" "));
  }

  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(" ")];
};

const getCaptionStyle = (style: string): CaptionStyleConfig => {
  if (style === "clean-minimal") {
    return {
      uppercase: false,
      maxCharsPerLine: 34,
      maxLines: 3,
      layers: [
        {
          fontSize: "h*0.022",
          fontColor: "white",
          borderW: 0,
          borderColor: "black@0",
          box: true,
          boxColor: "black@0.40",
          boxBorderW: 6,
          lineSpacing: 3,
        },
      ],
    };
  }

  if (style === "pop-neon") {
    return {
      uppercase: true,
      maxCharsPerLine: 26,
      maxLines: 3,
      layers: [
        {
          fontSize: "h*0.026",
          fontColor: "white",
          borderW: 5,
          borderColor: "white@0.14",
          box: false,
          lineSpacing: 3,
          alphaMultiplier: 0.42,
        },
        {
          fontSize: "h*0.024",
          fontColor: "white",
          borderW: 2,
          borderColor: "black@0.92",
          box: true,
          boxColor: "black@0.65",
          boxBorderW: 7,
          lineSpacing: 3,
          shadowColor: "white@0.32",
          shadowX: 0,
          shadowY: 0,
        },
      ],
    };
  }

  return {
    uppercase: true,
    maxCharsPerLine: 24,
    maxLines: 3,
    layers: [
      {
        fontSize: "h*0.026",
        fontColor: "white",
        borderW: 3,
        borderColor: "black@0.96",
        box: true,
        boxColor: "black@0.72",
        boxBorderW: 8,
        lineSpacing: 3,
      },
    ],
  };
};

const buildCaptionVideoFilters = (
  captions: ExportCaptionBlock[],
  options: CaptionExportOptions,
): string[] => {
  if (!captions.length) return [];

  const position = getCaptionPosition(options.position);
  const style = getCaptionStyle(options.style);
  const sorted = [...captions].sort(
    (a, b) => parseTimestampToSeconds(a.start) - parseTimestampToSeconds(b.start),
  );

  const filters: string[] = [];

  for (const caption of sorted) {
    const startRaw = parseTimestampToSeconds(caption.start) - options.offsetSeconds;
    const endRaw = parseTimestampToSeconds(caption.end) - options.offsetSeconds;
    if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) continue;
    if (endRaw <= 0) continue;

    const start = Math.max(0, startRaw);
    const end = Math.max(start + 0.06, endRaw);
    const duration = end - start;
    const fadeSeconds = Math.min(0.2, Math.max(0.08, duration * 0.2));

    const normalizedText = style.uppercase ? caption.text.toUpperCase() : caption.text;
    const wrappedLines = wrapCaptionLines(normalizedText, style.maxCharsPerLine, style.maxLines);
    if (!wrappedLines.length) continue;

    const fadeInEnd = Math.min(end, start + fadeSeconds);
    const fadeOutStart = Math.max(start, end - fadeSeconds);
    const animatedAlpha = `if(lt(t,${start.toFixed(3)}),0,if(lt(t,${fadeInEnd.toFixed(3)}),(t-${start.toFixed(3)})/${Math.max(0.02, fadeInEnd - start).toFixed(3)},if(lt(t,${fadeOutStart.toFixed(3)}),1,if(lt(t,${end.toFixed(3)}),(${end.toFixed(3)}-t)/${Math.max(0.02, end - fadeOutStart).toFixed(3)},0))))`;

    for (const layer of style.layers) {
      const enableExpr = escapeFilterExpression(
        `between(t,${start.toFixed(3)},${end.toFixed(3)})`,
      );

      for (let lineIndex = 0; lineIndex < wrappedLines.length; lineIndex += 1) {
        const text = escapeDrawtext(wrappedLines[lineIndex]);
        if (!text) continue;

        const centerOffset = lineIndex - (wrappedLines.length - 1) / 2;
        const lineGapPx = 2;
        const boxPaddingPx = layer.box ? Math.max(0, (layer.boxBorderW ?? 0) * 2) : 0;
        const lineHeightExpr = `(text_h+${lineGapPx + boxPaddingPx})`;
        const yExpr =
          centerOffset === 0
            ? position.y
            : `(${position.y})+(${centerOffset.toFixed(3)})*${lineHeightExpr}`;

        const parts = [
          `drawtext=text='${text}'`,
          `fontsize=${layer.fontSize}`,
          `fontcolor=${layer.fontColor}`,
          `line_spacing=${layer.lineSpacing}`,
          `x=${position.x}`,
          `y=${yExpr}`,
          `borderw=${layer.borderW}`,
          `bordercolor=${layer.borderColor}`,
          `fix_bounds=1`,
          `enable=${enableExpr}`,
        ];

        if (layer.box) {
          parts.push("box=1");
          parts.push(`boxcolor=${layer.boxColor ?? "black@0.6"}`);
          parts.push(`boxborderw=${layer.boxBorderW ?? 10}`);
        } else {
          parts.push("box=0");
        }

        if (layer.shadowColor) parts.push(`shadowcolor=${layer.shadowColor}`);
        if (typeof layer.shadowX === "number") parts.push(`shadowx=${layer.shadowX}`);
        if (typeof layer.shadowY === "number") parts.push(`shadowy=${layer.shadowY}`);

        const alphaMultiplier = Number.isFinite(layer.alphaMultiplier)
          ? Math.max(0, Math.min(1, Number(layer.alphaMultiplier)))
          : 1;
        if (options.animated) {
          const alphaExpr =
            alphaMultiplier === 1
              ? animatedAlpha
              : `(${animatedAlpha})*${alphaMultiplier.toFixed(3)}`;
          parts.push(`alpha=${escapeFilterExpression(alphaExpr)}`);
        } else if (alphaMultiplier !== 1) {
          parts.push(`alpha=${alphaMultiplier.toFixed(3)}`);
        }

        filters.push(parts.join(":"));
      }
    }
  }

  return filters;
};

const MOBILE_CANVAS_WIDTH = 720;
const MOBILE_CANVAS_HEIGHT = 1280;
const MOBILE_CANVAS_ASPECT = MOBILE_CANVAS_WIDTH / MOBILE_CANVAS_HEIGHT;

const fitVideoToMobileCanvas = async (args: {
  inputPath: string;
  outputPath: string;
}): Promise<void> =>
  new Promise((resolve, reject) => {
    const stderrLines: string[] = [];

    ffmpeg(args.inputPath)
      .videoFilters([
        `scale='if(gt(a,${MOBILE_CANVAS_ASPECT}),${MOBILE_CANVAS_WIDTH},-2)':'if(gt(a,${MOBILE_CANVAS_ASPECT}),-2,${MOBILE_CANVAS_HEIGHT})'`,
        `pad=${MOBILE_CANVAS_WIDTH}:${MOBILE_CANVAS_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`,
      ])
      .outputOptions([
        "-map 0:v:0",
        "-map 0:a?",
        "-c:v libx264",
        "-preset veryfast",
        "-crf 18",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .format("mp4")
      .on("end", () => resolve())
      .on("stderr", (line: string) => {
        if (!line) return;
        stderrLines.push(line);
        if (stderrLines.length > 14) stderrLines.shift();
      })
      .on("error", (error: Error) =>
        reject(new ReelRenderError("mobile-fit", error.message, stderrLines.slice(-8))),
      )
      .save(args.outputPath);
  });

const burnCaptionsIntoVideo = async (args: {
  inputPath: string;
  outputPath: string;
  captions: ExportCaptionBlock[];
  options: CaptionExportOptions;
}): Promise<void> =>
  new Promise((resolve, reject) => {
    const filters = buildCaptionVideoFilters(args.captions, args.options);
    if (!filters.length) {
      resolve();
      return;
    }

    const stderrLines: string[] = [];
    ffmpeg(args.inputPath)
      .videoFilters(filters)
      .outputOptions([
        "-map 0:v:0",
        "-map 0:a?",
        "-c:v libx264",
        "-preset veryfast",
        "-crf 18",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .format("mp4")
      .on("end", () => resolve())
      .on("stderr", (line: string) => {
        if (!line) return;
        stderrLines.push(line);
        if (stderrLines.length > 14) stderrLines.shift();
      })
      .on("error", (error: Error) =>
        reject(new ReelRenderError("caption-burn", error.message, stderrLines.slice(-8))),
      )
      .save(args.outputPath);
  });

const renderReel = async (args: {
  videoPath: string;
  voicePath?: string;
  musicPath?: string;
  musicVolume: number;
  muteOriginalAudio: boolean;
  outputPath: string;
}): Promise<void> =>
  new Promise(async (resolve, reject) => {
    try {
      const command = ffmpeg(args.videoPath);
      const stderrLines: string[] = [];
      const videoHasAudio = await hasAudioStream(args.videoPath);

      let voiceInputIndex: number | null = null;
      let musicInputIndex: number | null = null;
      let nextInputIndex = 1;

      if (args.voicePath) {
        command.input(args.voicePath);
        voiceInputIndex = nextInputIndex;
        nextInputIndex += 1;
      }

      if (args.musicPath) {
        command.input(args.musicPath);
        musicInputIndex = nextInputIndex;
      }

      const mixInputs: string[] = [];
      const filterParts: string[] = [];
      if (!args.muteOriginalAudio && videoHasAudio) mixInputs.push("[0:a]");
      if (voiceInputIndex !== null) mixInputs.push(`[${voiceInputIndex}:a]`);
      if (musicInputIndex !== null) {
        filterParts.push(
          `[${musicInputIndex}:a]volume=${Math.max(0, Math.min(100, args.musicVolume)) / 100}[bgm]`,
        );
        mixInputs.push("[bgm]");
      }

      command.outputOptions(["-movflags +faststart"]);
      command.videoCodec("copy");

      if (mixInputs.length === 0) {
        command.outputOptions(["-map 0:v", "-an"]);
      } else if (mixInputs.length === 1) {
        filterParts.push(`${mixInputs[0]}anull[aout]`);
        command.complexFilter(filterParts);
        command.outputOptions(["-map 0:v", "-map [aout]", "-c:a aac", "-b:a 192k"]);
      } else {
        filterParts.push(
          `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=2[aout]`,
        );
        command.complexFilter(filterParts);
        command.outputOptions(["-map 0:v", "-map [aout]", "-c:a aac", "-b:a 192k"]);
      }

      command
        .format("mp4")
        .on("end", () => resolve())
        .on("stderr", (line: string) => {
          if (!line) return;
          stderrLines.push(line);
          if (stderrLines.length > 14) stderrLines.shift();
        })
        .on("error", (error: Error) =>
          reject(new ReelRenderError("audio-mix", error.message, stderrLines.slice(-8))),
        )
        .save(args.outputPath);
    } catch (error) {
      reject(error);
    }
  });

router.post(
  "/api/render-reel",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "voiceover", maxCount: 1 },
    { name: "music", maxCount: 1 },
  ]),
  async (req, res) => {
    let tempDir = "";
    const requestId = randomUUID().slice(0, 8);

    try {
      const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
      const video = files.video?.[0];
      const voiceover = files.voiceover?.[0];
      const music = files.music?.[0];

      const captions = parseCaptions(getTextField(req.body.captions));
      const captionPosition = getTextField(req.body.captionPosition, "bottom-center");
      const captionStyle = getTextField(req.body.captionStyle, "anime-bold");
      const captionAnimation = getTextField(req.body.captionAnimation, "true") === "true";
      const rawCaptionOffset = Number(getTextField(req.body.captionOffsetSeconds, "0"));
      const captionOffsetSeconds = Number.isFinite(rawCaptionOffset)
        ? Math.max(-3, Math.min(3, rawCaptionOffset))
        : 0;
      const muteOriginalAudio = getTextField(req.body.muteOriginalAudio, "false") === "true";
      const musicVolume = Number(getTextField(req.body.musicVolume, "35"));

      renderTrace("info", requestId, "request_received", {
        hasVideo: Boolean(video),
        hasVoiceover: Boolean(voiceover),
        hasMusic: Boolean(music),
        captionsCount: captions.length,
        captionPosition,
        captionStyle,
        captionAnimation,
        captionOffsetSeconds,
        muteOriginalAudio,
        musicVolume,
      });

      if (!video) {
        renderTrace("warn", requestId, "request_rejected_missing_video");
        return res.status(400).json({ error: "video is required" });
      }

      tempDir = await fs.mkdtemp(path.join(tmpdir(), "reel-render-"));
      renderTrace("info", requestId, "temp_dir_created", { tempDir });
      const videoPath = path.join(tempDir, "video.mp4");
      await fs.writeFile(videoPath, video.buffer);
      renderTrace("info", requestId, "video_written", {
        bytes: video.buffer.byteLength,
      });

      const mobileFittedPath = path.join(tempDir, "mobile-fitted.mp4");
      renderTrace("info", requestId, "mobile_fit_start");
      await fitVideoToMobileCanvas({
        inputPath: videoPath,
        outputPath: mobileFittedPath,
      });
      renderTrace("info", requestId, "mobile_fit_success");
      let sourceVideoPath = mobileFittedPath;

      if (captions.length) {
        const captionedPath = path.join(tempDir, "captioned.mp4");
        renderTrace("info", requestId, "caption_burn_start", {
          captionsCount: captions.length,
        });
        await burnCaptionsIntoVideo({
          inputPath: sourceVideoPath,
          outputPath: captionedPath,
          captions,
          options: {
            position: captionPosition,
            style: captionStyle,
            animated: captionAnimation,
            offsetSeconds: captionOffsetSeconds,
          },
        });
        renderTrace("info", requestId, "caption_burn_success");
        sourceVideoPath = captionedPath;
      } else {
        renderTrace("info", requestId, "caption_burn_skipped");
      }

      let voicePath: string | undefined;
      if (voiceover) {
        voicePath = path.join(tempDir, "voiceover.mp3");
        await fs.writeFile(voicePath, voiceover.buffer);
        renderTrace("info", requestId, "voiceover_written", {
          bytes: voiceover.buffer.byteLength,
        });
      }

      let musicPath: string | undefined;
      if (music) {
        musicPath = path.join(tempDir, "music.mp3");
        await fs.writeFile(musicPath, music.buffer);
        renderTrace("info", requestId, "music_written", {
          bytes: music.buffer.byteLength,
        });
      }

      const outputPath = path.join(tempDir, `rendered-${randomUUID()}.mp4`);
      renderTrace("info", requestId, "audio_mix_start");
      await renderReel({
        videoPath: sourceVideoPath,
        voicePath,
        musicPath,
        musicVolume,
        muteOriginalAudio,
        outputPath,
      });
      renderTrace("info", requestId, "audio_mix_success");

      const output = await fs.readFile(outputPath);
      renderTrace("info", requestId, "output_read", {
        bytes: output.byteLength,
      });
      res.setHeader("content-type", "video/mp4");
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-render-request-id", requestId);
      renderTrace("info", requestId, "response_ready");
      return res.status(200).send(output);
    } catch (error) {
      const details =
        error instanceof ReelRenderError
          ? {
              stage: error.stage,
              message: error.message,
              stderrTail: error.stderrTail,
              ffmpegPath: ffmpegPathUsed ?? "ffmpeg (PATH)",
              ffprobePath: ffprobePathUsed ?? "ffprobe (PATH)",
              requestId,
            }
          : {
              stage: "unknown",
              message: error instanceof Error ? error.message : String(error),
              ffmpegPath: ffmpegPathUsed ?? "ffmpeg (PATH)",
              ffprobePath: ffprobePathUsed ?? "ffprobe (PATH)",
              requestId,
            };

      renderTrace("error", requestId, "render_failed", details);
      return res.status(500).json({
        error: "could not render output video right now",
        details,
      });
    } finally {
      if (tempDir) {
        renderTrace("info", requestId, "cleanup_start", { tempDir });
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        renderTrace("info", requestId, "cleanup_complete");
      }
    }
  },
);

export default router;
