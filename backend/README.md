# Media Backend

This Express service hosts runtime-heavy media endpoints that require ffmpeg/ffprobe.

## Endpoints

- `POST /api/merge-clips`
- `POST /api/render-reel`
- `GET /api/clip-proxy`
- `GET /healthz`

## Local dev

1. Install deps: `npm --prefix backend install`
2. Run backend: `npm run dev:backend` (from repo root) or `npm --prefix backend run dev`
3. In the Next app env, set `MEDIA_BACKEND_URL=http://localhost:8787`

## Deploy

- Deploy `/backend` as a Docker service on Render/Railway.
- Set env vars:
  - `PORT` (platform default is fine)
  - Optional: `FFMPEG_PATH`, `FFPROBE_PATH`
  - Optional: `CORS_ORIGIN` (comma-separated allowlist; unset allows all)
  - Optional: `MERGE_MAX_CLIPS` and `MERGE_MAX_SOURCE_BYTES` (OOM safety for clip merge)
- In Vercel (Next app), set:
  - `MEDIA_BACKEND_URL=https://<your-media-backend-domain>`
  - `NEXT_PUBLIC_MEDIA_BACKEND_URL=https://<your-media-backend-domain>`
  - Existing `OPENAI_API_KEY` remains in Vercel for OpenAI routes.
