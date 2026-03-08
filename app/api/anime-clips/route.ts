import * as cheerio from "cheerio";
import { NextResponse } from "next/server";

type AnimeItem = {
  title: string;
  url: string;
  image: string;
};

type FolderItem = {
  id: string;
  label: string;
  parentId: string;
  hasChildren: boolean;
};

type ClipItem = {
  id: string;
  name: string;
  duration: string;
  streamUrl: string;
  thumbnail: string;
};

const CLIPS_PAGE = "https://animeclips.online/clips/";
const ADMIN_AJAX_URL = "https://animeclips.online/wp-admin/admin-ajax.php";

const normalizeUrl = (url: string): string => {
  if (!url) return "";
  return url.startsWith("http") ? url : `https://animeclips.online${url}`;
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
  if (!response.ok) throw new Error("could not fetch anime list");

  const html = await response.text();
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const allItems: AnimeItem[] = [];

  $(".bdt-ep-advanced-image-gallery-thumbnail a").each((_, node) => {
    const anchor = $(node);
    const url = normalizeUrl(anchor.attr("href") ?? "");
    const image = normalizeUrl(anchor.find("img").attr("src") ?? "");
    const title = url
      .replace("https://animeclips.online/", "")
      .replace(/\/$/, "")
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");

    if (!url || seen.has(url)) return;
    seen.add(url);
    allItems.push({ title, url, image });
  });

  const lowered = query.trim().toLowerCase();
  if (!lowered) return allItems.slice(0, 40);

  return allItems
    .filter((item) => item.title.toLowerCase().includes(lowered))
    .slice(0, 40);
};

const fetchFolderTree = async (animeUrl: string): Promise<FolderItem[]> => {
  const pageResponse = await fetch(animeUrl, {
    cache: "no-store",
    headers: { "user-agent": "Mozilla/5.0" },
  });
  if (!pageResponse.ok) throw new Error("could not fetch anime page");

  const html = await pageResponse.text();
  const config = parseUseYourDriveConfig(html);
  if (!config.token || !config.accountId || !config.refreshNonce) {
    throw new Error("clip source config missing");
  }

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

  if (!treeResponse.ok) throw new Error("could not fetch folder tree");
  const treePayload = (await treeResponse.json()) as {
    tree?: Array<{
      id: string;
      parent: string;
      text: string;
      children?: string[];
      li_attr?: { [key: string]: string };
    }>;
  };

  const tree = Array.isArray(treePayload.tree) ? treePayload.tree : [];
  return tree
    .filter((node) => node.id && node.parent !== "#")
    .map((node) => ({
      id: node.id,
      label: node.text,
      parentId: node.parent,
      hasChildren: node.li_attr?.["has-childen"] !== "no",
    }));
};

const fetchClipsForFolder = async (
  animeUrl: string,
  folderId: string,
): Promise<ClipItem[]> => {
  const pageResponse = await fetch(animeUrl, {
    cache: "no-store",
    headers: { "user-agent": "Mozilla/5.0" },
  });
  if (!pageResponse.ok) throw new Error("could not fetch anime page");

  const html = await pageResponse.text();
  const config = parseUseYourDriveConfig(html);
  if (!config.token || !config.accountId || !config.refreshNonce) {
    throw new Error("clip source config missing");
  }

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

  if (!clipsResponse.ok) throw new Error("could not fetch clips");
  const payload = (await clipsResponse.json()) as { html?: string };
  const htmlPayload = payload.html ?? "";
  const $ = cheerio.load(htmlPayload);

  const clips: ClipItem[] = [];
  $(".files-container .entry.file").each((_, node) => {
    const entry = $(node);
    const id = entry.attr("data-id") ?? "";
    const name = `${entry.attr("data-name") ?? "clip"}.mp4`;
    const duration = entry.find(".entry-duration").text().replace(/\s+/g, " ").trim();
    const thumbnail =
      entry.find(".entry_thumbnail img").attr("data-src") ??
      entry.find(".entry_thumbnail img").attr("src") ??
      "";
    const streamUrl =
      entry.find("video source").attr("data-src") ??
      entry.find(".entry_action_download").attr("href") ??
      "";

    if (!id || !streamUrl) return;
    clips.push({
      id,
      name,
      duration,
      streamUrl: normalizeUrl(streamUrl),
      thumbnail: normalizeUrl(thumbnail),
    });
  });

  return clips.slice(0, 120);
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const step = searchParams.get("step") ?? "anime";

  try {
    if (step === "anime") {
      const query = searchParams.get("q") ?? "";
      const items = await fetchAnimeList(query);
      return NextResponse.json({ items });
    }

    if (step === "folders") {
      const animeUrl = searchParams.get("animeUrl") ?? "";
      if (!animeUrl) {
        return NextResponse.json({ error: "animeUrl is required" }, { status: 400 });
      }
      const folders = await fetchFolderTree(animeUrl);
      return NextResponse.json({ folders });
    }

    if (step === "clips") {
      const animeUrl = searchParams.get("animeUrl") ?? "";
      const folderId = searchParams.get("folderId") ?? "";
      if (!animeUrl || !folderId) {
        return NextResponse.json(
          { error: "animeUrl and folderId are required" },
          { status: 400 },
        );
      }
      const clips = await fetchClipsForFolder(animeUrl, folderId);
      return NextResponse.json({ clips });
    }

    return NextResponse.json({ error: "invalid step" }, { status: 400 });
  } catch {
    return NextResponse.json(
      { error: "could not load clips from anime source right now" },
      { status: 500 },
    );
  }
}
