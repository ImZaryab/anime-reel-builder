import express from "express";
import { ffmpegPathUsed, ffprobePathUsed } from "./lib/binaries";
import { logger } from "./lib/logger";
import clipProxyRouter from "./routes/clip-proxy";
import mergeClipsRouter from "./routes/merge-clips";
import renderReelRouter from "./routes/render-reel";

const normalizeOrigin = (origin: string): string => origin.trim().replace(/\/+$/, "");

const app = express();
const port = Number(process.env.PORT || 8787);
const configuredCorsOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((origin) => normalizeOrigin(origin))
  .filter(Boolean);

app.disable("x-powered-by");
app.use((req, res, next) => {
  const requestOrigin = normalizeOrigin(
    typeof req.headers.origin === "string" ? req.headers.origin : "",
  );
  const allowAnyOrigin = configuredCorsOrigins.length === 0;
  const allowedOrigin = allowAnyOrigin
    ? "*"
    : configuredCorsOrigins.includes(requestOrigin)
      ? requestOrigin
      : "";

  if (allowedOrigin) {
    res.setHeader("access-control-allow-origin", allowedOrigin);
    res.setHeader("vary", "origin");
  }
  res.setHeader(
    "access-control-allow-methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  res.setHeader(
    "access-control-allow-headers",
    "Content-Type,Authorization,Range",
  );
  res.setHeader(
    "access-control-expose-headers",
    "x-merge-request-id,x-merge-trim-applied,x-render-request-id,content-range,content-length",
  );

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/healthz", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "media-backend",
    ffmpegPath: ffmpegPathUsed ?? null,
    ffprobePath: ffprobePathUsed ?? null,
  });
});

app.use(clipProxyRouter);
app.use(mergeClipsRouter);
app.use(renderReelRouter);

app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});

app.listen(port, "0.0.0.0", () => {
  logger.info("server_started", {
    port,
    ffmpegPath: ffmpegPathUsed ?? "ffmpeg (PATH)",
    ffprobePath: ffprobePathUsed ?? "ffprobe (PATH)",
    corsOrigins: configuredCorsOrigins.length ? configuredCorsOrigins : ["*"],
  });
});
