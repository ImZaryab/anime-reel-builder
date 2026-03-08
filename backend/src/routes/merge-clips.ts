import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Response } from "express";
import { Router } from "express";
import { ffmpeg } from "../lib/binaries";
import { logger } from "../lib/logger";

type MergeClip = {
  streamUrl: string;
  refererUrl?: string;
};

type MergeRequest = {
  clips?: MergeClip[];
  targetDurationSeconds?: number;
  maxOverrunSeconds?: number;
};

const router = Router();
const allowedProtocols = new Set(["http:", "https:"]);

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const mergeMaxClips = parsePositiveInt(process.env.MERGE_MAX_CLIPS, 12);
const mergeMaxSourceBytes = parsePositiveInt(
  process.env.MERGE_MAX_SOURCE_BYTES,
  40 * 1024 * 1024,
);
const headerProbeBytes = 4096;
type TraceLevel = "info" | "warn" | "error";

const memorySnapshot = () => {
  const usage = process.memoryUsage();
  return {
    rssMb: Math.round(usage.rss / 1024 / 1024),
    heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
    externalMb: Math.round(usage.external / 1024 / 1024),
  };
};

const trace = (
  level: TraceLevel,
  requestId: string,
  event: string,
  payload?: Record<string, unknown>,
) => {
  logger[level](event, {
    scope: "merge-clips",
    requestId,
    memory: memorySnapshot(),
    ...(payload ?? {}),
  });
};

const looksLikeVideoBytes = (buffer: Buffer): boolean => {
  if (buffer.length < 12) return false;

  const ftyp = buffer.subarray(4, 8).toString("ascii");
  if (ftyp === "ftyp") return true;

  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return true;
  }

  if (buffer.subarray(0, 4).toString("ascii") === "OggS") return true;
  if (buffer.subarray(0, 3).toString("ascii") === "FLV") return true;
  if (buffer[0] === 0x47 && (buffer.length < 189 || buffer[188] === 0x47)) return true;

  return false;
};

const fetchClipToFile = async (args: {
  requestId: string;
  index: number;
  streamUrl: string;
  refererUrl?: string;
  outputPath: string;
}): Promise<{ bytes: number }> => {
  const attempts: Array<{ withReferer: boolean; withRange: boolean }> = [
    { withReferer: true, withRange: true },
    { withReferer: false, withRange: true },
    { withReferer: true, withRange: false },
    { withReferer: false, withRange: false },
  ];

  let lastError = "direct fetch did not return a valid video file";

  for (const attempt of attempts) {
    await fs.rm(args.outputPath, { force: true }).catch(() => {});
    try {
      const attemptLabel = `${attempt.withReferer ? "referer" : "no-referer"}_${attempt.withRange ? "range" : "no-range"}`;
      trace("info", args.requestId, "clip_download_attempt_start", {
        index: args.index,
        attempt: attemptLabel,
      });
      const headers = new Headers({
        "user-agent": "Mozilla/5.0",
        accept: "*/*",
      });
      if (attempt.withRange) headers.set("range", "bytes=0-");

      if (args.refererUrl && attempt.withReferer) {
        try {
          const referer = new URL(args.refererUrl);
          if (allowedProtocols.has(referer.protocol)) {
            headers.set("referer", referer.toString());
            headers.set("origin", referer.origin);
          }
        } catch {
          // ignore invalid referer
        }
      }

      const response = await fetch(args.streamUrl, {
        method: "GET",
        headers,
        cache: "no-store",
        redirect: "follow",
      });
      if (!(response.ok || response.status === 206)) {
        lastError = `upstream returned status ${response.status}`;
        trace("warn", args.requestId, "clip_download_attempt_non_ok", {
          index: args.index,
          attempt: attemptLabel,
          status: response.status,
        });
        continue;
      }

      const contentLengthHeader = response.headers.get("content-length");
      const contentLength = Number(contentLengthHeader ?? "");
      if (Number.isFinite(contentLength) && contentLength > mergeMaxSourceBytes) {
        lastError = `clip exceeded max source bytes (${contentLength} > ${mergeMaxSourceBytes})`;
        trace("warn", args.requestId, "clip_download_attempt_too_large", {
          index: args.index,
          attempt: attemptLabel,
          contentLength,
          maxSourceBytes: mergeMaxSourceBytes,
        });
        continue;
      }

      if (!response.body) {
        lastError = "upstream returned no body";
        trace("warn", args.requestId, "clip_download_attempt_no_body", {
          index: args.index,
          attempt: attemptLabel,
        });
        continue;
      }

      const writer = createWriteStream(args.outputPath, { flags: "w" });
      let totalBytes = 0;
      const headerChunks: Buffer[] = [];
      let headerCollectedBytes = 0;

      writer.on("error", (error) => {
        lastError = error.message;
      });

      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        totalBytes += value.byteLength;
        if (totalBytes > mergeMaxSourceBytes) {
          throw new Error(`clip exceeded max source bytes (${mergeMaxSourceBytes})`);
        }

        const chunk = Buffer.from(value);
        if (headerCollectedBytes < headerProbeBytes) {
          const remaining = headerProbeBytes - headerCollectedBytes;
          const headChunk = chunk.subarray(0, Math.min(remaining, chunk.length));
          headerChunks.push(headChunk);
          headerCollectedBytes += headChunk.length;
        }

        if (!writer.write(chunk)) {
          await once(writer, "drain");
        }
      }

      writer.end();
      await once(writer, "finish");

      if (totalBytes <= 0) {
        lastError = "empty clip body";
        trace("warn", args.requestId, "clip_download_attempt_empty_body", {
          index: args.index,
          attempt: attemptLabel,
        });
        continue;
      }

      const header = Buffer.concat(headerChunks);
      if (!looksLikeVideoBytes(header)) {
        lastError = "downloaded file did not look like a video";
        trace("warn", args.requestId, "clip_download_attempt_not_video", {
          index: args.index,
          attempt: attemptLabel,
          totalBytes,
        });
        continue;
      }

      trace("info", args.requestId, "clip_download_attempt_success", {
        index: args.index,
        attempt: attemptLabel,
        totalBytes,
      });
      return { bytes: totalBytes };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "download failed";
      trace("warn", args.requestId, "clip_download_attempt_failed", {
        index: args.index,
        error: lastError,
      });
    }
  }

  throw new Error(lastError);
};

const runFfmpeg = (
  inputPaths: string[],
  outputPath: string,
  codec: "libx264" | "mpeg4",
): Promise<void> =>
  new Promise((resolve, reject) => {
    const command = ffmpeg();
    for (const inputPath of inputPaths) {
      command.input(inputPath);
    }
    const concatInputs = inputPaths.map((_, index) => `[${index}:v]`).join("");
    const filterChains = [`${concatInputs}concat=n=${inputPaths.length}:v=1:a=0[vout]`];

    command
      .complexFilter(filterChains)
      .outputOptions([
        "-map [vout]",
        "-an",
        "-movflags +faststart",
        "-preset veryfast",
        ...(codec === "libx264" ? ["-crf 23"] : ["-q:v 6"]),
      ])
      .videoCodec(codec)
      .format("mp4")
      .on("end", () => resolve())
      .on("error", (error: Error) => reject(error))
      .save(outputPath);
  });

const probeDurationSeconds = (inputPath: string): Promise<number> =>
  new Promise((resolve) => {
    ffmpeg.ffprobe(inputPath, (error, metadata) => {
      if (error) {
        resolve(0);
        return;
      }
      const formatDuration = Number(metadata.format?.duration ?? 0);
      if (Number.isFinite(formatDuration) && formatDuration > 0) {
        resolve(formatDuration);
        return;
      }
      const videoStream = (metadata.streams ?? []).find(
        (stream) => stream.codec_type === "video",
      );
      const streamDuration = Number(videoStream?.duration ?? 0);
      resolve(Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : 0);
    });
  });

const trimVideoToDuration = (
  inputPath: string,
  outputPath: string,
  seconds: number,
): Promise<void> =>
  new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-t",
        `${Math.max(0.2, seconds)}`,
        "-movflags +faststart",
        "-preset veryfast",
        "-an",
      ])
      .videoCodec("libx264")
      .format("mp4")
      .on("end", () => resolve())
      .on("error", (error: Error) => reject(error))
      .save(outputPath);
  });

const normalizeClip = (
  inputPath: string,
  outputPath: string,
  codec: "libx264" | "mpeg4",
): Promise<{ ok: boolean; error?: string }> =>
  new Promise((resolve) => {
    ffmpeg(inputPath)
      .noAudio()
      .videoCodec(codec)
      .outputOptions([
        "-movflags +faststart",
        "-preset veryfast",
        ...(codec === "libx264" ? ["-crf 23"] : ["-q:v 6"]),
      ])
      .videoFilters([
        "scale=720:1280:force_original_aspect_ratio=decrease",
        "pad=720:1280:(ow-iw)/2:(oh-ih)/2:black",
        "fps=30",
        "format=yuv420p",
      ])
      .format("mp4")
      .on("end", () => resolve({ ok: true }))
      .on("error", (error: Error) => resolve({ ok: false, error: error.message }))
      .save(outputPath);
  });

const streamVideoFileResponse = async (args: {
  res: Response;
  filePath: string;
  requestId: string;
  trimApplied: boolean;
}): Promise<void> => {
  const stats = await fs.stat(args.filePath);
  args.res.status(200);
  args.res.setHeader("content-type", "video/mp4");
  args.res.setHeader("cache-control", "no-store");
  args.res.setHeader("content-length", String(stats.size));
  args.res.setHeader("x-merge-request-id", args.requestId);
  args.res.setHeader("x-merge-trim-applied", args.trimApplied ? "true" : "false");

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(args.filePath);
    stream.on("error", reject);
    args.res.on("finish", () => resolve());
    args.res.on("close", () => resolve());
    stream.pipe(args.res);
  });
};

router.post("/api/merge-clips", async (req, res) => {
  const requestId = randomUUID().slice(0, 8);
  let tempDir = "";

  try {
    const body = req.body as MergeRequest;
    const clips = Array.isArray(body.clips) ? body.clips : [];
    const clipsForMerge =
      clips.length > mergeMaxClips ? clips.slice(0, mergeMaxClips) : clips;
    const targetDurationSeconds = Number(body.targetDurationSeconds ?? 0);
    const maxOverrunSeconds = Number(body.maxOverrunSeconds ?? 3);

    trace("info", requestId, "request_received", {
      requested: clips.length,
      effectiveRequested: clipsForMerge.length,
      targetDurationSeconds,
      maxOverrunSeconds,
    });

    if (!clipsForMerge.length) {
      trace("warn", requestId, "request_rejected_empty_clips");
      return res.status(400).json({ error: "clips are required" });
    }

    if (clips.length > mergeMaxClips) {
      trace("warn", requestId, "clip_count_capped", {
        requested: clips.length,
        maxAllowed: mergeMaxClips,
      });
    }

    tempDir = await fs.mkdtemp(path.join(tmpdir(), "reel-merge-"));
    trace("info", requestId, "temp_dir_created", { tempDir });
    const inputPaths: string[] = [];
    let downloadFailures = 0;
    let normalizeFailures = 0;
    let lastDownloadError = "";
    let mergeError = "";

    for (let index = 0; index < clipsForMerge.length; index += 1) {
      const clip = clipsForMerge[index];
      if (!clip?.streamUrl) continue;

      try {
        trace("info", requestId, "clip_processing_start", {
          index,
          streamUrl: clip.streamUrl,
        });
        const parsed = new URL(clip.streamUrl);
        if (!allowedProtocols.has(parsed.protocol)) {
          downloadFailures += 1;
          lastDownloadError = "unsupported protocol";
          trace("warn", requestId, "clip_processing_skipped_protocol", {
            index,
            protocol: parsed.protocol,
          });
          continue;
        }

        const rawPath = path.join(tempDir, `raw-${String(index).padStart(3, "0")}.mp4`);
        const { bytes } = await fetchClipToFile({
          requestId,
          index,
          streamUrl: clip.streamUrl,
          refererUrl: clip.refererUrl,
          outputPath: rawPath,
        });
        trace("info", requestId, "clip_downloaded", { index, bytes });

        const normalizedPath = path.join(tempDir, `norm-${String(index).padStart(3, "0")}.mp4`);
        trace("info", requestId, "clip_normalize_start", {
          index,
          codec: "libx264",
        });
        const libx264Result = await normalizeClip(rawPath, normalizedPath, "libx264");
        const stats = await fs.stat(normalizedPath).catch(() => null);
        if (!stats || stats.size === 0 || !libx264Result.ok) {
          trace("warn", requestId, "clip_normalize_fallback", {
            index,
            codec: "mpeg4",
            libx264Error: libx264Result.error ?? null,
          });
          await normalizeClip(rawPath, normalizedPath, "mpeg4");
        }
        const fallbackStats = await fs.stat(normalizedPath).catch(() => null);
        if (!fallbackStats || fallbackStats.size === 0) {
          normalizeFailures += 1;
          trace("warn", requestId, "clip_normalize_failed", { index });
          continue;
        }

        inputPaths.push(normalizedPath);
        trace("info", requestId, "clip_normalized", {
          index,
          downloadedBytes: bytes,
          normalizedBytes: fallbackStats.size,
        });
      } catch (error) {
        downloadFailures += 1;
        lastDownloadError = error instanceof Error ? error.message : "unknown download error";
        trace("warn", requestId, "clip_processing_failed", {
          index,
          error: lastDownloadError,
        });
      }
    }

    trace("info", requestId, "clip_processing_complete", {
      requested: clipsForMerge.length,
      usableInputs: inputPaths.length,
      downloadFailures,
      normalizeFailures,
      lastDownloadError: lastDownloadError || null,
    });

    if (!inputPaths.length) {
      trace("error", requestId, "no_usable_inputs", {
        requested: clipsForMerge.length,
        downloadFailures,
        normalizeFailures,
        lastDownloadError: lastDownloadError || null,
      });
      return res.status(500).json({
        error: "could not download valid clips for merge",
        details: {
          requested: clipsForMerge.length,
          downloaded: inputPaths.length,
          downloadFailures,
          normalizeFailures,
          lastDownloadError,
          requestId,
        },
      });
    }

    let finalPath = inputPaths[0];
    let trimApplied = false;

    if (inputPaths.length > 1) {
      const outputPath = path.join(tempDir, `merged-${randomUUID()}.mp4`);
      trace("info", requestId, "merge_start", {
        usableInputs: inputPaths.length,
      });

      try {
        trace("info", requestId, "merge_codec_start", { codec: "libx264" });
        await runFfmpeg(inputPaths, outputPath, "libx264");
        trace("info", requestId, "merge_codec_success", { codec: "libx264" });
      } catch (error) {
        mergeError = error instanceof Error ? error.message : "libx264 merge failed";
        trace("warn", requestId, "merge_codec_failed", {
          codec: "libx264",
          error: mergeError,
        });
        try {
          trace("info", requestId, "merge_codec_start", { codec: "mpeg4" });
          await runFfmpeg(inputPaths, outputPath, "mpeg4");
          trace("info", requestId, "merge_codec_success", { codec: "mpeg4" });
        } catch (fallbackError) {
          const fallbackMessage =
            fallbackError instanceof Error ? fallbackError.message : "mpeg4 merge failed";
          trace("error", requestId, "merge_failed", {
            mergeError,
            fallbackMessage,
            requested: clipsForMerge.length,
            downloaded: inputPaths.length,
            downloadFailures,
            normalizeFailures,
            lastDownloadError,
          });
          return res.status(500).json({
            error: "could not merge clips right now",
            details: {
              requested: clipsForMerge.length,
              downloaded: inputPaths.length,
              downloadFailures,
              normalizeFailures,
              lastDownloadError,
              mergeError,
              fallbackMessage,
              requestId,
            },
          });
        }
      }

      finalPath = outputPath;
    }

    const finalDuration = await probeDurationSeconds(finalPath);
    trace("info", requestId, "final_duration_probed", {
      finalDurationSeconds: Number(finalDuration.toFixed(2)),
    });
    const trimThreshold = targetDurationSeconds > 0 ? targetDurationSeconds + maxOverrunSeconds : 0;

    if (trimThreshold > 0 && finalDuration > trimThreshold) {
      const trimmedPath = path.join(tempDir, `trimmed-${randomUUID()}.mp4`);
      try {
        trace("info", requestId, "trim_start", {
          trimThreshold,
          targetDurationSeconds,
        });
        await trimVideoToDuration(finalPath, trimmedPath, targetDurationSeconds);
        const trimmedStats = await fs.stat(trimmedPath).catch(() => null);
        if (trimmedStats && trimmedStats.size > 0) {
          finalPath = trimmedPath;
          trimApplied = true;
          trace("info", requestId, "trim_success", { trimmedBytes: trimmedStats.size });
        }
      } catch {
        trace("warn", requestId, "trim_failed");
      }
    }

    trace("info", requestId, "response_stream_start", {
      trimApplied,
      finalDurationSeconds: Number(finalDuration.toFixed(2)),
    });

    await streamVideoFileResponse({
      res,
      filePath: finalPath,
      requestId,
      trimApplied,
    });
    trace("info", requestId, "response_stream_complete");
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected merge route failure";
    trace("error", requestId, "route_failed", { message });
    return res.status(500).json({
      error: "could not merge clips right now",
      details: { requestId, message },
    });
  } finally {
    if (tempDir) {
      trace("info", requestId, "cleanup_start", { tempDir });
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      trace("info", requestId, "cleanup_complete");
    }
  }
});

export default router;
