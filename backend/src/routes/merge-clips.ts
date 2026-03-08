import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
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

const looksLikeVideoBuffer = (buffer: Buffer): boolean => {
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

const fetchClipBuffer = async (streamUrl: string, refererUrl?: string): Promise<Buffer> => {
  const attempts: Array<{ withReferer: boolean; withRange: boolean }> = [
    { withReferer: true, withRange: true },
    { withReferer: false, withRange: true },
    { withReferer: true, withRange: false },
    { withReferer: false, withRange: false },
  ];

  for (const attempt of attempts) {
    try {
      const headers = new Headers({
        "user-agent": "Mozilla/5.0",
        accept: "*/*",
      });
      if (attempt.withRange) {
        headers.set("range", "bytes=0-");
      }

      if (refererUrl && attempt.withReferer) {
        try {
          const referer = new URL(refererUrl);
          if (allowedProtocols.has(referer.protocol)) {
            headers.set("referer", referer.toString());
            headers.set("origin", referer.origin);
          }
        } catch {
          // ignore invalid referer
        }
      }

      const response = await fetch(streamUrl, {
        method: "GET",
        headers,
        cache: "no-store",
        redirect: "follow",
      });
      if (!(response.ok || response.status === 206)) continue;

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (!buffer.byteLength) continue;
      if (!looksLikeVideoBuffer(buffer)) continue;
      return buffer;
    } catch {
      // try next strategy
    }
  }

  throw new Error("direct fetch did not return a valid video file");
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

router.post("/api/merge-clips", async (req, res) => {
  const requestId = randomUUID().slice(0, 8);
  let tempDir = "";

  try {
    const body = req.body as MergeRequest;
    const clips = Array.isArray(body.clips) ? body.clips : [];
    const targetDurationSeconds = Number(body.targetDurationSeconds ?? 0);
    const maxOverrunSeconds = Number(body.maxOverrunSeconds ?? 3);

    if (!clips.length) {
      return res.status(400).json({ error: "clips are required" });
    }

    tempDir = await fs.mkdtemp(path.join(tmpdir(), "reel-merge-"));
    const inputPaths: string[] = [];
    let downloadFailures = 0;
    let normalizeFailures = 0;
    let lastDownloadError = "";
    let mergeError = "";

    for (let index = 0; index < clips.length; index += 1) {
      const clip = clips[index];
      if (!clip?.streamUrl) continue;

      try {
        const parsed = new URL(clip.streamUrl);
        if (!allowedProtocols.has(parsed.protocol)) continue;
        const buffer = await fetchClipBuffer(clip.streamUrl, clip.refererUrl);
        const rawPath = path.join(tempDir, `raw-${String(index).padStart(3, "0")}.mp4`);
        await fs.writeFile(rawPath, buffer);

        const normalizedPath = path.join(
          tempDir,
          `norm-${String(index).padStart(3, "0")}.mp4`,
        );
        const libx264Result = await normalizeClip(rawPath, normalizedPath, "libx264");
        const stats = await fs.stat(normalizedPath).catch(() => null);
        if (!stats || stats.size === 0 || !libx264Result.ok) {
          await normalizeClip(rawPath, normalizedPath, "mpeg4");
        }
        const fallbackStats = await fs.stat(normalizedPath).catch(() => null);
        if (!fallbackStats || fallbackStats.size === 0) {
          normalizeFailures += 1;
          continue;
        }
        inputPaths.push(normalizedPath);
      } catch (error) {
        downloadFailures += 1;
        lastDownloadError = error instanceof Error ? error.message : "unknown download error";
      }
    }

    if (!inputPaths.length) {
      return res.status(500).json({
        error: "could not download valid clips for merge",
        details: {
          requested: clips.length,
          downloaded: inputPaths.length,
          downloadFailures,
          normalizeFailures,
          lastDownloadError,
          requestId,
        },
      });
    }

    if (inputPaths.length === 1) {
      const singlePath = inputPaths[0];
      let finalPath = singlePath;
      let trimApplied = false;
      const singleDuration = await probeDurationSeconds(singlePath);
      const trimThreshold = targetDurationSeconds > 0 ? targetDurationSeconds + maxOverrunSeconds : 0;
      if (trimThreshold > 0 && singleDuration > trimThreshold) {
        const trimmedSinglePath = path.join(tempDir, `trimmed-single-${randomUUID()}.mp4`);
        try {
          await trimVideoToDuration(singlePath, trimmedSinglePath, targetDurationSeconds);
          finalPath = trimmedSinglePath;
          trimApplied = true;
        } catch {
          // noop
        }
      }

      const singleBuffer = await fs.readFile(finalPath);
      res.setHeader("content-type", "video/mp4");
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-merge-request-id", requestId);
      res.setHeader("x-merge-trim-applied", trimApplied ? "true" : "false");
      return res.status(200).send(singleBuffer);
    }

    const outputPath = path.join(tempDir, `merged-${randomUUID()}.mp4`);
    try {
      await runFfmpeg(inputPaths, outputPath, "libx264");
    } catch (error) {
      mergeError = error instanceof Error ? error.message : "libx264 merge failed";
      try {
        await runFfmpeg(inputPaths, outputPath, "mpeg4");
      } catch (fallbackError) {
        const fallbackMessage =
          fallbackError instanceof Error ? fallbackError.message : "mpeg4 merge failed";
        logger.error("merge_failed", {
          scope: "merge-clips",
          mergeError,
          fallbackMessage,
          requested: clips.length,
          downloaded: inputPaths.length,
          downloadFailures,
          normalizeFailures,
          lastDownloadError,
          requestId,
        });
        return res.status(500).json({
          error: "could not merge clips right now",
          details: {
            requested: clips.length,
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

    const mergedBuffer = await fs.readFile(outputPath);
    let finalBuffer = mergedBuffer;
    let trimApplied = false;
    const mergedDuration = await probeDurationSeconds(outputPath);
    const trimThreshold = targetDurationSeconds > 0 ? targetDurationSeconds + maxOverrunSeconds : 0;

    if (trimThreshold > 0 && mergedDuration > trimThreshold) {
      const trimmedPath = path.join(tempDir, `trimmed-${randomUUID()}.mp4`);
      try {
        await trimVideoToDuration(outputPath, trimmedPath, targetDurationSeconds);
        const trimmedBuffer = await fs.readFile(trimmedPath);
        if (trimmedBuffer.byteLength > 0) {
          finalBuffer = trimmedBuffer;
          trimApplied = true;
        }
      } catch {
        // noop
      }
    }

    res.setHeader("content-type", "video/mp4");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-merge-request-id", requestId);
    res.setHeader("x-merge-trim-applied", trimApplied ? "true" : "false");
    return res.status(200).send(finalBuffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected merge route failure";
    return res.status(500).json({
      error: "could not merge clips right now",
      details: { requestId, message },
    });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

export default router;
