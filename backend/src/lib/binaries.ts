import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

type BinaryName = "ffmpeg" | "ffprobe";

const getSystemBinary = (name: BinaryName): string | null => {
  const command = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(command, [name], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const found = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return found && existsSync(found) ? found : null;
};

const getBundledFfmpegPath = (): string | null => {
  const localFallback = path.join(
    process.cwd(),
    "node_modules",
    "ffmpeg-static",
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  if (existsSync(localFallback)) return localFallback;
  if (ffmpegStatic && existsSync(ffmpegStatic)) return ffmpegStatic;
  return null;
};

const getBundledFfprobePath = (): string | null => {
  const bundled = ffprobe.path;
  if (bundled && existsSync(bundled)) return bundled;
  return null;
};

const ffmpegSupportsFilter = (ffmpegBinaryPath: string, filterName: string): boolean => {
  const result = spawnSync(ffmpegBinaryPath, ["-hide_banner", "-filters"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) return false;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.includes(filterName);
};

const resolveFfmpegPath = (): string | null => {
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const system = getSystemBinary("ffmpeg");
  const bundled = getBundledFfmpegPath();

  if (system && ffmpegSupportsFilter(system, "drawtext")) return system;
  if (bundled && ffmpegSupportsFilter(bundled, "drawtext")) return bundled;
  if (system) return system;
  if (bundled) return bundled;
  return null;
};

const resolveFfprobePath = (): string | null => {
  const envPath = process.env.FFPROBE_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const system = getSystemBinary("ffprobe");
  if (system) return system;

  return getBundledFfprobePath();
};

export const ffmpegPathUsed = resolveFfmpegPath();
export const ffprobePathUsed = resolveFfprobePath();

if (ffmpegPathUsed) ffmpeg.setFfmpegPath(ffmpegPathUsed);
if (ffprobePathUsed) ffmpeg.setFfprobePath(ffprobePathUsed);

export { ffmpeg };
