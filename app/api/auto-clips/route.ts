import * as cheerio from "cheerio";
import OpenAI from "openai";
import { NextResponse } from "next/server";

type AnimeItem = {
  title: string;
  url: string;
};

type FolderItem = {
  id: string;
  label: string;
  hasChildren: boolean;
};

type ClipItem = {
  id: string;
  name: string;
  durationLabel: string;
  durationSeconds: number;
  streamUrl: string;
  animeTitle: string;
  refererUrl?: string;
};

type GenerateRequest = {
  transcript: string;
  strategy?: string;
  targetDurationSeconds: number;
  count?: number;
  excludeClipIds?: string[];
};

const CLIPS_PAGE = "https://animeclips.online/clips/";
const ADMIN_AJAX_URL = "https://animeclips.online/wp-admin/admin-ajax.php";

const normalizeUrl = (url: string): string => {
  if (!url) return "";
  return url.startsWith("http") ? url : `https://animeclips.online${url}`;
};

const parseDuration = (label: string): number => {
  const clean = label.replace(/[^\d:]/g, "");
  if (!clean) return 4;
  const parts = clean.split(":").map((part) => Number(part));
  if (parts.some(Number.isNaN)) return 4;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] || 4;
};

const parseUseYourDriveConfig = (html: string) => {
  const $ = cheerio.load(html);
  const moduleNode = $(".wpcp-module.UseyourDrive").first();
  const token = moduleNode.attr("data-token") ?? "";
  const accountId = moduleNode.attr("data-account-id") ?? "";
  const folderPath = moduleNode.attr("data-path") ?? "bnVsbA==";
  const sort = moduleNode.attr("data-sort") ?? "name:asc";

  const varsMatch = html.match(/var UseyourDrive_vars = (\{[\s\S]*?\});/);
  const varsRaw = varsMatch?.[1] ?? "";
  const refreshNonceMatch = varsRaw.match(/"refresh_nonce":"([^"]+)"/);
  const refreshNonce = refreshNonceMatch?.[1] ?? "";

  return { token, accountId, folderPath, sort, refreshNonce };
};

const fetchAnimeList = async (query: string): Promise<AnimeItem[]> => {
  const response = await fetch(CLIPS_PAGE, {
    cache: "no-store",
    headers: { "user-agent": "Mozilla/5.0" },
  });
  if (!response.ok) return [];

  const html = await response.text();
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const items: AnimeItem[] = [];

  $(".bdt-ep-advanced-image-gallery-thumbnail a").each((_, node) => {
    const anchor = $(node);
    const url = normalizeUrl(anchor.attr("href") ?? "");
    if (!url || seen.has(url)) return;
    seen.add(url);

    const title = url
      .replace("https://animeclips.online/", "")
      .replace(/\/$/, "")
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");

    items.push({ title, url });
  });

  const lowered = query.trim().toLowerCase();
  if (!lowered) return items.slice(0, 20);
  return items
    .filter((item) => item.title.toLowerCase().includes(lowered))
    .slice(0, 20);
};

const fetchFolders = async (animeUrl: string): Promise<FolderItem[]> => {
  const pageResponse = await fetch(animeUrl, {
    cache: "no-store",
    headers: { "user-agent": "Mozilla/5.0" },
  });
  if (!pageResponse.ok) return [];

  const html = await pageResponse.text();
  const config = parseUseYourDriveConfig(html);
  if (!config.token || !config.accountId || !config.refreshNonce) return [];

  const form = new URLSearchParams();
  form.set("action", "useyourdrive-get-filelist");
  form.set("listtoken", config.token);
  form.set("account_id", config.accountId);
  form.set("lastFolder", "");
  form.set("folderPath", config.folderPath);
  form.set("sort", config.sort);
  form.set("query", "");
  form.set("_ajax_nonce", config.refreshNonce);
  form.set("page_url", animeUrl);

  const treeResponse = await fetch(ADMIN_AJAX_URL, {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "user-agent": "Mozilla/5.0",
    },
    body: form.toString(),
  });

  if (!treeResponse.ok) return [];
  const payload = (await treeResponse.json()) as {
    tree?: Array<{ id: string; text: string; parent: string; li_attr?: { [key: string]: string } }>;
  };

  const tree = Array.isArray(payload.tree) ? payload.tree : [];
  return tree
    .filter((node) => node.id && node.parent !== "#")
    .map((node) => ({
      id: node.id,
      label: node.text,
      hasChildren: node.li_attr?.["has-childen"] !== "no",
    }));
};

const fetchClips = async (animeTitle: string, animeUrl: string, folderId: string): Promise<ClipItem[]> => {
  const pageResponse = await fetch(animeUrl, {
    cache: "no-store",
    headers: { "user-agent": "Mozilla/5.0" },
  });
  if (!pageResponse.ok) return [];

  const html = await pageResponse.text();
  const config = parseUseYourDriveConfig(html);
  if (!config.token || !config.accountId || !config.refreshNonce) return [];

  const form = new URLSearchParams();
  form.set("action", "useyourdrive-get-filelist");
  form.set("listtoken", config.token);
  form.set("account_id", config.accountId);
  form.set("lastFolder", folderId);
  form.set("folderPath", config.folderPath);
  form.set("sort", config.sort);
  form.set("query", "");
  form.set("_ajax_nonce", config.refreshNonce);
  form.set("page_url", animeUrl);

  const clipsResponse = await fetch(ADMIN_AJAX_URL, {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "user-agent": "Mozilla/5.0",
    },
    body: form.toString(),
  });

  if (!clipsResponse.ok) return [];
  const payload = (await clipsResponse.json()) as { html?: string };
  const $ = cheerio.load(payload.html ?? "");

  const clips: ClipItem[] = [];
  $(".files-container .entry.file").each((_, node) => {
    const entry = $(node);
    const id = entry.attr("data-id") ?? "";
    const rawName = entry.attr("data-name") ?? "clip";
    const durationLabel = entry.find(".entry-duration").text().replace(/\s+/g, " ").trim();
    const streamUrl = entry.find("video source").attr("data-src") ?? "";
    if (!id || !streamUrl) return;

    clips.push({
      id,
      name: rawName.endsWith(".mp4") ? rawName : `${rawName}.mp4`,
      durationLabel,
      durationSeconds: parseDuration(durationLabel),
      streamUrl: normalizeUrl(streamUrl),
      animeTitle,
      refererUrl: animeUrl,
    });
  });

  return clips;
};

const inferSearchQuery = async (transcript: string, strategy?: string): Promise<string> => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return `${transcript} ${strategy ?? ""}`.trim().split(/\s+/).slice(0, 5).join(" ");
  }

  try {
    const client = new OpenAI({ apiKey });
    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content:
            "You analyze voiceover transcript vibe. Return a short anime search phrase, 2-5 words, and include the word anime.",
        },
        {
          role: "user",
          content: `Transcript:\n${transcript.slice(0, 1800)}\n\nStrategy:\n${(strategy ?? "").slice(0, 900)}`,
        },
      ],
      max_output_tokens: 20,
    });
    const text = response.output_text?.trim();
    if (!text) return `${transcript} ${strategy ?? ""}`.trim().split(/\s+/).slice(0, 5).join(" ");
    return text.replace(/[^\w\s-]/g, "").trim();
  } catch {
    return `${transcript} ${strategy ?? ""}`.trim().split(/\s+/).slice(0, 5).join(" ");
  }
};

const isPlayableClip = async (clip: ClipItem): Promise<boolean> => {
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
        headers.set("range", "bytes=0-2047");
      }
      if (clip.refererUrl && attempt.withReferer) {
        headers.set("referer", clip.refererUrl);
        try {
          headers.set("origin", new URL(clip.refererUrl).origin);
        } catch {
          // ignore invalid referer origin
        }
      }

      const response = await fetch(clip.streamUrl, {
        method: "GET",
        headers,
        cache: "no-store",
        redirect: "follow",
      });

      if (!(response.ok || response.status === 206)) continue;
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.includes("video") || contentType.includes("octet-stream")) {
        return true;
      }

      if (/\.mp4($|\?)/i.test(clip.streamUrl)) {
        return true;
      }
    } catch {
      // keep trying
    }
  }

  return false;
};

const filterPlayableClips = async (clips: ClipItem[]): Promise<ClipItem[]> => {
  const playable: ClipItem[] = [];
  for (const clip of clips) {
    // Stop once we have a healthy pool to keep generation quick.
    if (playable.length >= 120) break;
    const ok = await isPlayableClip(clip);
    if (ok) playable.push(clip);
  }
  return playable;
};

const pickCandidateFolders = (folders: FolderItem[]): FolderItem[] => {
  if (!folders.length) return [];

  const byPriority = folders.filter(
    (folder) => !folder.hasChildren && /episode|ep|op|ed|nc|scene|clip|short/i.test(folder.label),
  );
  if (byPriority.length) return byPriority.slice(0, 6);

  const leafFolders = folders.filter((folder) => !folder.hasChildren);
  if (leafFolders.length) return leafFolders.slice(0, 6);

  return folders.slice(0, 6);
};

const selectClips = (
  candidates: ClipItem[],
  targetDurationSeconds: number,
  count?: number,
): ClipItem[] => {
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  if (count && count > 0) return shuffled.slice(0, count);

  const output: ClipItem[] = [];
  let total = 0;
  const target = Math.max(6, targetDurationSeconds);
  const tolerance = 5;
  const minTarget = Math.max(4, target - tolerance);
  const maxTarget = target + tolerance;

  for (const clip of shuffled) {
    if (output.length >= 24) break;
    const clipLength = Math.max(1, clip.durationSeconds);
    const nextTotal = total + clipLength;

    if (nextTotal > maxTarget && total >= minTarget) {
      continue;
    }

    output.push(clip);
    total = nextTotal;
    if (total >= minTarget && total <= maxTarget) break;
  }

  if (total < minTarget) {
    const remaining = shuffled.filter((clip) => !output.some((item) => item.id === clip.id));
    const sortedByLength = remaining.sort(
      (a, b) => Math.max(1, a.durationSeconds) - Math.max(1, b.durationSeconds),
    );
    for (const clip of sortedByLength) {
      if (output.length >= 24) break;
      output.push(clip);
      total += Math.max(1, clip.durationSeconds);
      if (total >= minTarget) break;
    }
  }

  return output.slice(0, 24);
};

export async function POST(request: Request) {
  const body = (await request.json()) as GenerateRequest;
  const transcript = body.transcript?.trim();
  const targetDurationSeconds = Math.max(4, Math.floor(body.targetDurationSeconds || 12));
  const count = body.count && body.count > 0 ? Math.floor(body.count) : undefined;
  const exclude = new Set(body.excludeClipIds ?? []);

  if (!transcript) {
    return NextResponse.json({ error: "transcript is required" }, { status: 400 });
  }

  const query = await inferSearchQuery(transcript, body.strategy);
  const animes = await fetchAnimeList(query);
  const animePool = animes.length ? animes : await fetchAnimeList("");
  const pickedAnimes = animePool.slice(0, 10);

  const candidates: ClipItem[] = [];

  for (const anime of pickedAnimes) {
    const folders = await fetchFolders(anime.url);
    const targetFolders = pickCandidateFolders(folders);
    for (const folder of targetFolders) {
      const clips = await fetchClips(anime.title, anime.url, folder.id);
      for (const clip of clips) {
        if (!exclude.has(clip.id)) candidates.push(clip);
      }
      if (candidates.length > 200) break;
    }
    if (candidates.length > 200) break;
  }

  if (!candidates.length) {
    return NextResponse.json(
      { error: "could not find matching anime clips right now" },
      { status: 500 },
    );
  }

  const playableCandidates = await filterPlayableClips(candidates);
  if (!playableCandidates.length) {
    return NextResponse.json(
      { error: "could not find playable anime clips right now" },
      { status: 500 },
    );
  }

  const selected = selectClips(playableCandidates, targetDurationSeconds, count).map((clip, index) => ({
    ...clip,
    segmentId: `seg-${Date.now()}-${index}-${clip.id.slice(0, 6)}`,
  }));

  return NextResponse.json({
    query,
    sourceMix: {
      internet: 0,
      animeLibrary: playableCandidates.length,
    },
    clips: selected,
  });
}
