"use client";

import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Chip,
  Input,
  Select,
  SelectItem,
  Switch,
  Textarea,
} from "@heroui/react";
import { motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";

type CaptionBlock = {
  id: string;
  text: string;
  start: string;
  end: string;
};

type TimedTranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

type TimedTranscriptWord = {
  start: number;
  end: number;
  word: string;
};

type AutoClipItem = {
  segmentId: string;
  id: string;
  name: string;
  durationLabel: string;
  durationSeconds: number;
  streamUrl: string;
  animeTitle: string;
  refererUrl?: string;
  replaceOnRegenerate: boolean;
};

type DraftPayload = {
  reelTitle: string;
  clipSource: string;
  remoteClipUrl: string;
  muteClipAudio: boolean;
  voiceoverName: string;
  musicName: string;
  hasMusic: boolean;
  captionSeedText: string;
  captionPosition: string;
  captionStyle: string;
  captionAnimation: boolean;
  captionOffsetSeconds: number;
  clipStrategy: string;
  captions: CaptionBlock[];
};

type StoredMediaRecord = {
  name: string;
  blob: Blob;
  type: string;
};

const MEDIA_DB_NAME = "anime-reel-studio-media";
const MEDIA_STORE_NAME = "uploads";

const captionPositions = [
  { key: "bottom-center", label: "bottom center" },
  { key: "middle-center", label: "middle center" },
  { key: "top-center", label: "top center" },
];

const captionStyles = [
  { key: "anime-bold", label: "anime bold" },
  { key: "clean-minimal", label: "clean minimal" },
  { key: "pop-neon", label: "pop neon" },
];

const splitIntoCaptionBlocks = (text: string): CaptionBlock[] => {
  const chunks = text
    .split(/[.!?\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);

  return chunks.map((chunk, index) => {
    const startSeconds = index * 2;
    const endSeconds = startSeconds + 2;

    return {
      id: `${index}-${chunk.slice(0, 10)}`,
      text: chunk,
      start: formatCaptionTimestamp(startSeconds),
      end: formatCaptionTimestamp(endSeconds),
    };
  });
};

const generateTimedCaptionBlocks = (
  text: string,
  totalDurationSeconds?: number,
): CaptionBlock[] => {
  const lines = text
    .split(/[.!?\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 24);

  if (!lines.length) return [];

  const safeDuration =
    totalDurationSeconds && totalDurationSeconds > 0
      ? totalDurationSeconds
      : undefined;

  if (!safeDuration) return splitIntoCaptionBlocks(text);

  const weights = lines.map((line) =>
    Math.max(1, line.split(/\s+/).filter(Boolean).length),
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const minSegment = 0.8;
  const base = minSegment * lines.length;
  const remaining = Math.max(0, safeDuration - base);

  let cursor = 0;
  return lines.map((line, index) => {
    const proportional = remaining * (weights[index] / totalWeight);
    const segment = minSegment + proportional;
    const start = cursor;
    const end = index === lines.length - 1 ? safeDuration : cursor + segment;
    cursor += segment;

    return {
      id: `${index}-${line.slice(0, 10)}-${Math.round(start * 10)}`,
      text: line,
      start: formatCaptionTimestamp(start),
      end: formatCaptionTimestamp(end),
    };
  });
};

const parseTimestampToSeconds = (value: string): number => {
  const cleaned = value.trim();
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

  return parts[0];
};

const formatCaptionTimestamp = (seconds: number): string => {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${secs.toFixed(2).padStart(5, "0")}`;
};

const shiftCaptionTimestamp = (value: string, deltaSeconds: number): string =>
  formatCaptionTimestamp(parseTimestampToSeconds(value) + deltaSeconds);

type NormalizedTranscriptToken = {
  raw: string;
  normalized: string;
};

type PreparedTimedWord = {
  word: string;
  normalized: string;
  start: number;
  end: number;
};

type NumericCaptionBlock = {
  id: string;
  text: string;
  start: number;
  end: number;
};

const normalizeCaptionToken = (value: string): string => {
  const clean = value
    .normalize("NFKD")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/…/g, "...")
    .replace(/%/g, " percent ")
    .replace(/&/g, " and ")
    .replace(/\+/g, " plus ")
    .replace(/(^|[\s])#(\d+)/g, "$1number $2")
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "")
    .toLowerCase()
    .trim();

  if (!clean) return "";
  return clean
    .replace(/[^a-z0-9'\s-]+/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .replace(/'/g, "")
    .trim();
};

const expandTokenToNormalizedPieces = (token: string): string[] => {
  const normalized = normalizeCaptionToken(token);
  if (!normalized) return [];
  return normalized
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
};

const tokenizeTranscriptWithNormalization = (
  text: string,
): NormalizedTranscriptToken[] =>
  text
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((token) => {
      const pieces = expandTokenToNormalizedPieces(token);
      if (!pieces.length) return [];
      if (pieces.length === 1) {
        return [{ raw: token, normalized: pieces[0] }];
      }
      return pieces.map((piece) => ({ raw: piece, normalized: piece }));
    });

const normalizeTimedWords = (
  words: TimedTranscriptWord[],
): PreparedTimedWord[] => {
  let runningEnd = 0;
  const prepared = words
    .map((word) => {
      const rawWord = String(word.word ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const start = Number.isFinite(word.start)
        ? Math.max(0, word.start)
        : runningEnd;
      const rawEnd = Number.isFinite(word.end) ? word.end : start + 0.2;
      const end = rawEnd > start ? rawEnd : start + 0.2;
      runningEnd = end;
      return { rawWord, start, end };
    })
    .filter((word) => word.rawWord.length > 0)
    .sort((a, b) => a.start - b.start);

  const expanded: PreparedTimedWord[] = [];
  for (const item of prepared) {
    const pieces = expandTokenToNormalizedPieces(item.rawWord);
    if (!pieces.length) continue;
    if (pieces.length === 1) {
      expanded.push({
        word: item.rawWord,
        normalized: pieces[0],
        start: item.start,
        end: item.end,
      });
      continue;
    }

    const pieceDuration = Math.max(
      0.08,
      (item.end - item.start) / pieces.length,
    );
    for (let index = 0; index < pieces.length; index += 1) {
      const start = item.start + pieceDuration * index;
      const end = Math.min(item.end, start + pieceDuration);
      expanded.push({
        word: pieces[index],
        normalized: pieces[index],
        start,
        end: Math.max(start + 0.08, end),
      });
    }
  }

  return expanded;
};

const finalizeCaptionText = (parts: string[]): string =>
  parts
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

const inferTranscriptTimelineDuration = (
  words: TimedTranscriptWord[],
  segments: TimedTranscriptSegment[],
): number | undefined => {
  const wordsEnd = words.reduce(
    (max, item) => Math.max(max, Number.isFinite(item.end) ? item.end : 0),
    0,
  );
  const segmentsEnd = segments.reduce(
    (max, item) => Math.max(max, Number.isFinite(item.end) ? item.end : 0),
    0,
  );
  const maxEnd = Math.max(wordsEnd, segmentsEnd, 0);
  return maxEnd > 0 ? maxEnd : undefined;
};

const smoothNumericCaptionBlocks = (
  blocks: NumericCaptionBlock[],
  totalDurationSeconds?: number,
): CaptionBlock[] => {
  if (!blocks.length) return [];
  const minDisplaySeconds = 0.65;
  const maxCharsPerSecond = 32;

  const sorted = [...blocks]
    .filter((item) => item.text.trim().length > 0)
    .sort((a, b) => a.start - b.start);

  const smoothed: NumericCaptionBlock[] = [];
  for (const item of sorted) {
    const previous = smoothed[smoothed.length - 1];
    let start = Math.max(0, item.start);
    if (previous) {
      start = Math.max(start, previous.end + 0.02);
    }

    let end = Math.max(item.end, start + minDisplaySeconds);
    if (totalDurationSeconds && end > totalDurationSeconds) {
      end = totalDurationSeconds;
      start = Math.max(0, Math.min(start, end - 0.2));
    }
    if (end <= start) continue;

    const text = finalizeCaptionText(item.text.split(/\s+/).filter(Boolean));
    if (!text) continue;

    const currentDuration = Math.max(0.2, end - start);
    const cps = text.length / currentDuration;
    if (cps > maxCharsPerSecond) {
      end = Math.max(
        start + minDisplaySeconds,
        start + text.length / maxCharsPerSecond,
      );
      if (totalDurationSeconds && end > totalDurationSeconds) {
        end = totalDurationSeconds;
      }
    }

    const duration = Math.max(0.2, end - start);
    const latest = smoothed[smoothed.length - 1];
    if (latest) {
      const gap = start - latest.end;
      if (duration < 0.75 && gap < 0.12) {
        const mergedText = finalizeCaptionText([latest.text, text]);
        const mergedDuration = Math.max(0.2, end - latest.start);
        const mergedCps = mergedText.length / mergedDuration;
        if (mergedCps <= maxCharsPerSecond) {
          latest.text = mergedText;
          latest.end = end;
          continue;
        }
      }
    }

    smoothed.push({
      id: item.id,
      text,
      start,
      end,
    });
  }

  return smoothed
    .filter((item) => item.end > item.start + 0.01)
    .map((item) => ({
      id: item.id,
      text: item.text,
      start: formatCaptionTimestamp(item.start),
      end: formatCaptionTimestamp(item.end),
    }));
};

const buildBlocksFromPreparedWords = (
  preparedWords: PreparedTimedWord[],
  totalDurationSeconds?: number,
): CaptionBlock[] => {
  if (!preparedWords.length) return [];

  const pauseBreakSeconds = 0.42;
  const minBlockSeconds = 0.95;
  const maxBlockSeconds = 2.8;
  const maxBlockWords = 12;
  const maxCharsPerSecond = 32;

  const numericBlocks: NumericCaptionBlock[] = [];
  let chunkWords: string[] = [];
  let chunkStart = preparedWords[0].start;
  let chunkEnd = preparedWords[0].end;

  const flush = () => {
    const captionText = finalizeCaptionText(chunkWords);
    if (!captionText) {
      chunkWords = [];
      return;
    }
    numericBlocks.push({
      id: `tw-${numericBlocks.length}-${Math.round(chunkStart * 100)}`,
      text: captionText,
      start: Math.max(0, chunkStart),
      end: Math.max(chunkStart + 0.2, chunkEnd + 0.06),
    });
    chunkWords = [];
  };

  for (let index = 0; index < preparedWords.length; index += 1) {
    const current = preparedWords[index];
    const previous = index > 0 ? preparedWords[index - 1] : null;
    if (!chunkWords.length) {
      chunkStart = current.start;
    } else if (previous) {
      const gap = Math.max(0, current.start - previous.end);
      const durationIfAdded = Math.max(0.2, current.end - chunkStart);
      const textIfAdded = finalizeCaptionText([...chunkWords, current.word]);
      const cpsIfAdded = textIfAdded.length / durationIfAdded;
      const sentenceEnd = /[.!?]$/.test(
        chunkWords[chunkWords.length - 1] ?? "",
      );
      const shouldBreak =
        gap >= pauseBreakSeconds ||
        durationIfAdded >= maxBlockSeconds ||
        chunkWords.length >= maxBlockWords ||
        cpsIfAdded > maxCharsPerSecond ||
        (sentenceEnd && durationIfAdded >= minBlockSeconds * 0.8);
      if (shouldBreak) {
        flush();
        chunkStart = current.start;
      }
    }

    chunkWords.push(current.word);
    chunkEnd = current.end;
  }
  flush();

  return smoothNumericCaptionBlocks(numericBlocks, totalDurationSeconds);
};

type IndexedCaptionToken = {
  normalized: string;
  blockIndex: number;
  localIndex: number;
  globalIndex: number;
};

const repairCaptionTextMissingWords = (
  captionBlocks: CaptionBlock[],
  transcriptText: string,
): CaptionBlock[] => {
  if (!captionBlocks.length || !transcriptText.trim()) return captionBlocks;

  const transcriptTokens = tokenizeTranscriptWithNormalization(
    transcriptText,
  ).filter((item) => item.normalized.length > 0);
  if (!transcriptTokens.length) return captionBlocks;

  const captionTokens: IndexedCaptionToken[] = [];
  captionBlocks.forEach((block, blockIndex) => {
    const pieces = block.text
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    let localIndex = 0;
    for (const piece of pieces) {
      const normalizedPieces = expandTokenToNormalizedPieces(piece);
      for (const normalized of normalizedPieces) {
        captionTokens.push({
          normalized,
          blockIndex,
          localIndex,
          globalIndex: captionTokens.length,
        });
      }
      localIndex += 1;
    }
  });

  if (!captionTokens.length) return captionBlocks;

  const transcriptCount = transcriptTokens.length;
  const captionCount = captionTokens.length;
  const lcs = Array.from({ length: transcriptCount + 1 }, () =>
    Array(captionCount + 1).fill(0),
  );
  for (let ti = transcriptCount - 1; ti >= 0; ti -= 1) {
    for (let ci = captionCount - 1; ci >= 0; ci -= 1) {
      if (transcriptTokens[ti].normalized === captionTokens[ci].normalized) {
        lcs[ti][ci] = lcs[ti + 1][ci + 1] + 1;
      } else {
        lcs[ti][ci] = Math.max(lcs[ti + 1][ci], lcs[ti][ci + 1]);
      }
    }
  }

  const matches: Array<{ transcriptIndex: number; captionIndex: number }> = [];
  let ti = 0;
  let ci = 0;
  while (ti < transcriptCount && ci < captionCount) {
    if (transcriptTokens[ti].normalized === captionTokens[ci].normalized) {
      matches.push({ transcriptIndex: ti, captionIndex: ci });
      ti += 1;
      ci += 1;
      continue;
    }
    if (lcs[ti + 1][ci] >= lcs[ti][ci + 1]) {
      ti += 1;
    } else {
      ci += 1;
    }
  }

  const matchedTranscriptIndexes = new Set(
    matches.map((item) => item.transcriptIndex),
  );
  const missingTranscriptIndexes = transcriptTokens
    .map((_, index) => index)
    .filter((index) => !matchedTranscriptIndexes.has(index));
  const missingRatio =
    missingTranscriptIndexes.length / Math.max(1, transcriptTokens.length);

  // Keep repairs conservative; if too many tokens are "missing", skip to avoid text corruption.
  if (missingRatio > 0.2) {
    console.info("[caption-quality]", {
      source: "text-repair-skipped",
      reason: "high_missing_ratio",
      missingRatio: Number(missingRatio.toFixed(3)),
      transcriptTokens: transcriptTokens.length,
      captionTokens: captionTokens.length,
    });
    return captionBlocks;
  }

  if (!missingTranscriptIndexes.length) {
    return captionBlocks;
  }

  // Deterministic repair: keep timings and reassign transcript tokens to existing blocks.
  // This prevents cascading text drift from repeated insertion passes.
  const tokenToBlock = new Array<number>(transcriptTokens.length).fill(-1);
  const matchedWithBlocks = matches.map((item) => ({
    transcriptIndex: item.transcriptIndex,
    blockIndex: captionTokens[item.captionIndex].blockIndex,
  }));

  if (!matchedWithBlocks.length) {
    return captionBlocks;
  }

  for (const item of matchedWithBlocks) {
    tokenToBlock[item.transcriptIndex] = item.blockIndex;
  }

  const first = matchedWithBlocks[0];
  const last = matchedWithBlocks[matchedWithBlocks.length - 1];

  for (let index = 0; index < first.transcriptIndex; index += 1) {
    tokenToBlock[index] = first.blockIndex;
  }
  for (
    let index = last.transcriptIndex + 1;
    index < transcriptTokens.length;
    index += 1
  ) {
    tokenToBlock[index] = last.blockIndex;
  }

  for (
    let matchIndex = 0;
    matchIndex < matchedWithBlocks.length - 1;
    matchIndex += 1
  ) {
    const current = matchedWithBlocks[matchIndex];
    const next = matchedWithBlocks[matchIndex + 1];
    const gap = next.transcriptIndex - current.transcriptIndex;
    if (gap <= 1) continue;

    for (let offset = 1; offset < gap; offset += 1) {
      const transcriptIndex = current.transcriptIndex + offset;
      if (current.blockIndex === next.blockIndex) {
        tokenToBlock[transcriptIndex] = current.blockIndex;
        continue;
      }

      const ratio = offset / gap;
      const interpolated =
        current.blockIndex + (next.blockIndex - current.blockIndex) * ratio;
      tokenToBlock[transcriptIndex] = Math.round(interpolated);
    }
  }

  for (let index = 0; index < tokenToBlock.length; index += 1) {
    if (tokenToBlock[index] >= 0) continue;
    tokenToBlock[index] = index > 0 ? tokenToBlock[index - 1] : 0;
  }

  const groupedWords = Array.from(
    { length: captionBlocks.length },
    () => [] as string[],
  );
  for (let index = 0; index < transcriptTokens.length; index += 1) {
    const clampedBlock = Math.max(
      0,
      Math.min(captionBlocks.length - 1, tokenToBlock[index]),
    );
    groupedWords[clampedBlock].push(transcriptTokens[index].raw);
  }

  const repaired = captionBlocks.map((block, index) => {
    const nextWords = groupedWords[index];
    return {
      ...block,
      text: nextWords.length ? finalizeCaptionText(nextWords) : block.text,
    };
  });

  console.info("[caption-quality]", {
    source: "text-repair",
    missingDetected: missingTranscriptIndexes.length,
    missingRatio: Number(missingRatio.toFixed(3)),
    blocks: repaired.length,
  });
  return repaired;
};

const buildCaptionBlocksFromTimedTranscript = (
  text: string,
  words: TimedTranscriptWord[],
  segments: TimedTranscriptSegment[],
  totalDurationSeconds?: number,
): CaptionBlock[] => {
  const transcriptTokens = tokenizeTranscriptWithNormalization(text);
  const preparedTimedWords = normalizeTimedWords(words);
  const directWordBlocks = buildBlocksFromPreparedWords(
    preparedTimedWords,
    totalDurationSeconds,
  );

  if (transcriptTokens.length && preparedTimedWords.length) {
    const averageWordDuration =
      preparedTimedWords.reduce(
        (sum, item) => sum + Math.max(0.08, item.end - item.start),
        0,
      ) / preparedTimedWords.length;

    const alignedWords: Array<{
      word: string;
      normalized: string;
      start: number;
      end: number;
      matched: boolean;
    }> = [];
    let timedIndex = 0;
    let previousEnd = Math.max(0, preparedTimedWords[0].start);

    for (const token of transcriptTokens) {
      let matchedIndex = -1;
      const scanTo = Math.min(preparedTimedWords.length, timedIndex + 8);
      for (let index = timedIndex; index < scanTo; index += 1) {
        if (preparedTimedWords[index].normalized === token.normalized) {
          matchedIndex = index;
          break;
        }
      }

      let start = previousEnd;
      let end = previousEnd + averageWordDuration;
      let matched = false;
      if (matchedIndex >= 0) {
        const picked = preparedTimedWords[matchedIndex];
        start = Math.max(previousEnd, picked.start);
        end = Math.max(start + 0.08, picked.end);
        timedIndex = matchedIndex + 1;
        matched = true;
      } else if (timedIndex < preparedTimedWords.length) {
        const picked = preparedTimedWords[timedIndex];
        start = Math.max(previousEnd, picked.start);
        const nextKnownStart = preparedTimedWords
          .slice(timedIndex + 1)
          .map((item) => item.start)
          .find((value) => Number.isFinite(value) && value > start);
        const available =
          typeof nextKnownStart === "number" && Number.isFinite(nextKnownStart)
            ? Math.max(0.08, nextKnownStart - start)
            : averageWordDuration;
        end = start + Math.min(Math.max(0.08, averageWordDuration), available);
        timedIndex += 1;
      }

      if (end <= start) end = start + 0.08;
      alignedWords.push({
        word: token.raw,
        normalized: token.normalized,
        start,
        end,
        matched,
      });
      previousEnd = end;
    }

    const remappedWordBlocks = buildBlocksFromPreparedWords(
      alignedWords.map((item) => ({
        word: item.word,
        normalized: item.normalized,
        start: item.start,
        end: item.end,
      })),
      totalDurationSeconds,
    );
    const smoothed = remappedWordBlocks.length
      ? remappedWordBlocks
      : directWordBlocks;
    if (smoothed.length) {
      const matchedCount = alignedWords.filter((item) => item.matched).length;
      const coverageRate =
        Math.round((matchedCount / Math.max(1, alignedWords.length)) * 10000) /
        100;
      const inflatedTokenRatio =
        alignedWords.length / Math.max(1, preparedTimedWords.length);
      const numericSmoothed = smoothed.map((item) => ({
        ...item,
        startSec: parseTimestampToSeconds(item.start),
        endSec: parseTimestampToSeconds(item.end),
      }));
      const avgCaptionDuration =
        numericSmoothed.reduce(
          (sum, item) => sum + (item.endSec - item.startSec),
          0,
        ) / Math.max(1, numericSmoothed.length);
      const cpsValues = numericSmoothed.map((item) => {
        const duration = Math.max(0.2, item.endSec - item.startSec);
        return item.text.length / duration;
      });
      const avgCps =
        cpsValues.reduce((sum, value) => sum + value, 0) /
        Math.max(1, cpsValues.length);
      const maxCpsValue = cpsValues.reduce(
        (max, value) => Math.max(max, value),
        0,
      );
      console.info("[caption-quality]", {
        source: "words",
        transcriptTokens: transcriptTokens.length,
        timedWords: preparedTimedWords.length,
        alignedWords: alignedWords.length,
        matchedWords: matchedCount,
        unmatchedWords: alignedWords.length - matchedCount,
        coverageRate,
        captionBlocks: smoothed.length,
        avgCaptionDuration: Number(avgCaptionDuration.toFixed(3)),
        avgCharsPerSecond: Number(avgCps.toFixed(2)),
        maxCharsPerSecond: Number(maxCpsValue.toFixed(2)),
      });
      const shouldPreferDirectWords =
        directWordBlocks.length > 0 &&
        (coverageRate < 90 || inflatedTokenRatio > 1.18);
      if (shouldPreferDirectWords) {
        console.info("[caption-quality]", {
          source: "words-direct-fallback",
          reason:
            coverageRate < 90 ? "low_coverage" : "transcript_token_inflation",
          coverageRate,
          inflatedTokenRatio: Number(inflatedTokenRatio.toFixed(3)),
        });
        return repairCaptionTextMissingWords(directWordBlocks, text);
      }
      return repairCaptionTextMissingWords(smoothed, text);
    }
  }

  if (directWordBlocks.length) {
    console.info("[caption-quality]", {
      source: "words-direct",
      captionBlocks: directWordBlocks.length,
    });
    return repairCaptionTextMissingWords(directWordBlocks, text);
  }

  const sortedSegments = [...segments]
    .filter((segment) => segment.text && segment.end > segment.start)
    .sort((a, b) => a.start - b.start);

  if (sortedSegments.length) {
    const output: NumericCaptionBlock[] = [];
    let cursor = 0;
    while (cursor < sortedSegments.length) {
      const start = sortedSegments[cursor].start;
      let end = sortedSegments[cursor].end;
      const textParts = [sortedSegments[cursor].text.trim()];
      cursor += 1;

      while (cursor < sortedSegments.length) {
        const gap = sortedSegments[cursor].start - end;
        const segmentDuration = end - start;
        if (gap >= 0.55 || segmentDuration >= 2.9 || textParts.length >= 3)
          break;
        textParts.push(sortedSegments[cursor].text.trim());
        end = sortedSegments[cursor].end;
        cursor += 1;
      }

      const line = textParts.join(" ").replace(/\s+/g, " ").trim();
      if (!line) continue;
      output.push({
        id: `s-${output.length}-${Math.round(start * 100)}`,
        text: line,
        start,
        end,
      });
    }
    if (output.length) {
      const smoothed = smoothNumericCaptionBlocks(output, totalDurationSeconds);
      const cpsValues = smoothed.map((item) => {
        const start = parseTimestampToSeconds(item.start);
        const end = parseTimestampToSeconds(item.end);
        return item.text.length / Math.max(0.2, end - start);
      });
      const avgCps =
        cpsValues.reduce((sum, value) => sum + value, 0) /
        Math.max(1, cpsValues.length);
      console.info("[caption-quality]", {
        source: "segments",
        segmentCount: sortedSegments.length,
        captionBlocks: smoothed.length,
        avgCharsPerSecond: Number(avgCps.toFixed(2)),
      });
      if (smoothed.length) return repairCaptionTextMissingWords(smoothed, text);
    }
  }

  const fallback = generateTimedCaptionBlocks(text, totalDurationSeconds);
  console.info("[caption-quality]", {
    source: "fallback",
    captionBlocks: fallback.length,
  });
  return repairCaptionTextMissingWords(fallback, text);
};

const formatSecondsToTimestamp = (seconds: number): string => {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

const truncateFileName = (name: string, maxLength = 32): string => {
  if (name.length <= maxLength) return name;
  return `${name.slice(0, maxLength - 3)}...`;
};

const resolveTranscribeTimeoutMs = (): number => {
  const raw =
    process.env.NEXT_PUBLIC_TRANSCRIBE_TIMEOUT_MS ??
    process.env.NEXT_PUBLIC_API_TIMEOUT_MS;
  const parsed = Number(raw ?? "");
  if (!Number.isFinite(parsed) || parsed < 120000) {
    return 720000;
  }
  return Math.floor(parsed);
};

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

const normalizeLocalMediaBackendUrl = (value: string): string => {
  const trimmed = trimTrailingSlash(value);
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol === "https:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    ) {
      parsed.protocol = "http:";
      return trimTrailingSlash(parsed.toString());
    }
    return trimTrailingSlash(parsed.toString());
  } catch {
    return trimmed;
  }
};

const getMediaBackendBaseUrl = (): string => {
  const explicit = normalizeLocalMediaBackendUrl(
    process.env.NEXT_PUBLIC_MEDIA_BACKEND_URL ?? "",
  );
  if (explicit) return explicit;

  if (
    typeof window !== "undefined" &&
    window.location.hostname === "localhost"
  ) {
    return "http://localhost:8787";
  }

  return "";
};

const toMediaApiUrl = (path: string): string => {
  const base = getMediaBackendBaseUrl();
  if (!base) return path;
  return `${base}${path}`;
};

const fetchMediaWithDirectFallback = async (
  path: string,
  init?: RequestInit,
): Promise<Response> => {
  const directUrl = toMediaApiUrl(path);
  const canFallback = directUrl !== path;

  try {
    const response = await fetch(path, init);
    if (!canFallback || response.ok || response.status < 500) {
      return response;
    }

    const responseText = await response.clone().text().catch(() => "");
    if (!/socket hang up|econnreset|failed to proxy/i.test(responseText)) {
      return response;
    }
  } catch (error) {
    if (!canFallback) {
      if (error instanceof Error) throw error;
      throw new Error("media request failed");
    }
  }

  return fetch(directUrl, init);
};

const toPlayableUrl = (url: string, refererUrl?: string): string => {
  if (!url.startsWith("http://") && !url.startsWith("https://")) return url;
  const refererParam = refererUrl
    ? `&referer=${encodeURIComponent(refererUrl)}`
    : "";
  return toMediaApiUrl(
    `/api/clip-proxy?url=${encodeURIComponent(url)}${refererParam}`,
  );
};

const openMediaDb = async (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(MEDIA_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEDIA_STORE_NAME)) {
        db.createObjectStore(MEDIA_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const saveMediaRecord = async (
  key: string,
  record: StoredMediaRecord,
): Promise<void> => {
  const db = await openMediaDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE_NAME, "readwrite");
    tx.objectStore(MEDIA_STORE_NAME).put(record, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  db.close();
};

const readMediaRecord = async (
  key: string,
): Promise<StoredMediaRecord | null> => {
  const db = await openMediaDb();
  const result = await new Promise<StoredMediaRecord | null>(
    (resolve, reject) => {
      const tx = db.transaction(MEDIA_STORE_NAME, "readonly");
      const req = tx.objectStore(MEDIA_STORE_NAME).get(key);
      req.onsuccess = () =>
        resolve((req.result as StoredMediaRecord | undefined) ?? null);
      req.onerror = () => reject(req.error);
    },
  );
  db.close();
  return result;
};

const emptyDraft: DraftPayload = {
  reelTitle: "",
  clipSource: "",
  remoteClipUrl: "",
  muteClipAudio: false,
  voiceoverName: "",
  musicName: "",
  hasMusic: false,
  captionSeedText: "",
  captionPosition: "bottom-center",
  captionStyle: "anime-bold",
  captionAnimation: true,
  captionOffsetSeconds: 0,
  clipStrategy: "",
  captions: [],
};

const fieldClassNames = {
  label:
    "!text-[#F5F5F5]/70 group-data-[focus=true]:!text-[#F5F5F5]/70 group-data-[filled-within=true]:!text-[#F5F5F5]/70 group-data-[has-value=true]:!text-[#F5F5F5]/70",
  input: "text-[#F5F5F5]/70 placeholder:text-[#F5F5F5]/50",
  value: "text-[#F5F5F5]/70",
  trigger:
    "bg-black/50 border border-white/15 text-[#F5F5F5]/70 data-[hover=true]:bg-black/60",
  inputWrapper:
    "bg-black/50 border border-white/15 text-[#F5F5F5]/70 data-[hover=true]:bg-black/60 group-data-[focus=true]:bg-black/60",
  innerWrapper: "text-[#F5F5F5]/70",
  mainWrapper: "text-[#F5F5F5]/70",
  description: "text-[#F5F5F5]/70",
  errorMessage: "text-[#F5F5F5]/70",
};

const buttonClassName =
  "bg-black text-[#F5F5F5] border border-white/15 data-[hover=true]:opacity-90";

const selectClassNames = {
  ...fieldClassNames,
  popoverContent: "bg-[#1C1C1C] border border-white/15",
  listbox: "text-[#F5F5F5]/70",
};

type StatusCalloutTone = "warning" | "progress";

const statusCalloutClasses: Record<
  StatusCalloutTone,
  {
    wrapper: string;
    icon: string;
    title: string;
    description: string;
  }
> = {
  warning: {
    wrapper: "rounded-xl border border-[#7a2f00] bg-[#4b1b00]/85 px-4 py-3",
    icon: "text-[#ffd7bf]",
    title: "text-sm font-medium text-[#fbe2d0]",
    description: "text-sm text-[#f5cdb3]/90",
  },
  progress: {
    wrapper: "rounded-xl border border-[#2d6a4f] bg-[#173b2c]/78 px-4 py-3",
    icon: "text-[#d5f7e7]",
    title: "text-sm font-medium text-[#e4fbf1]",
    description: "text-sm text-[#c8f0de]/90",
  },
};

const StatusCallout = ({
  title,
  description,
  tone,
}: {
  title: string;
  description?: string;
  tone: StatusCalloutTone;
}) => {
  const toneClasses = statusCalloutClasses[tone];

  return (
    <div className={toneClasses.wrapper}>
      <div className="flex items-start gap-2">
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className={`mt-0.5 h-5 w-5 flex-shrink-0 ${toneClasses.icon}`}
        >
          <path
            d="M12 3.5 2.9 19.2A1.3 1.3 0 0 0 4 21.1h16a1.3 1.3 0 0 0 1.1-1.9L12 3.5Zm0 5.4c.4 0 .8.3.8.8v4.8a.8.8 0 1 1-1.6 0V9.7c0-.5.4-.8.8-.8Zm0 8.6a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"
            fill="currentColor"
          />
        </svg>
        <div className="space-y-0.5">
          <p className={toneClasses.title}>{title}</p>
          {description ? (
            <p className={toneClasses.description}>{description}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default function Home() {
  const clipInputRef = useRef<HTMLInputElement | null>(null);
  const voiceoverInputRef = useRef<HTMLInputElement | null>(null);
  const musicInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const voiceTrackRef = useRef<HTMLAudioElement | null>(null);
  const musicTrackRef = useRef<HTMLAudioElement | null>(null);
  const clipObjectUrlRef = useRef("");
  const voiceObjectUrlRef = useRef("");
  const musicObjectUrlRef = useRef("");
  const mergedClipUrlRef = useRef("");
  const initialDraft = useMemo<DraftPayload>(() => {
    if (typeof window === "undefined") return emptyDraft;

    const saved = localStorage.getItem("anime-reel-studio-draft");
    if (!saved) return emptyDraft;

    try {
      const parsed = JSON.parse(saved) as Partial<DraftPayload>;
      return {
        ...emptyDraft,
        ...parsed,
        captions: Array.isArray(parsed.captions) ? parsed.captions : [],
      };
    } catch {
      localStorage.removeItem("anime-reel-studio-draft");
      return emptyDraft;
    }
  }, []);

  const [reelTitle, setReelTitle] = useState(initialDraft.reelTitle);
  const [clipSource, setClipSource] = useState(initialDraft.clipSource);
  const [remoteClipUrl, setRemoteClipUrl] = useState(
    initialDraft.remoteClipUrl,
  );
  const [muteClipAudio, setMuteClipAudio] = useState(
    initialDraft.muteClipAudio,
  );
  const [voiceoverName, setVoiceoverName] = useState(
    initialDraft.voiceoverName,
  );
  const [musicName, setMusicName] = useState(initialDraft.musicName);
  const [hasMusic, setHasMusic] = useState(initialDraft.hasMusic);
  const [captionSeedText, setCaptionSeedText] = useState(
    initialDraft.captionSeedText,
  );
  const [captionPosition, setCaptionPosition] = useState(
    initialDraft.captionPosition,
  );
  const [captionStyle, setCaptionStyle] = useState(initialDraft.captionStyle);
  const [captionAnimation, setCaptionAnimation] = useState(
    initialDraft.captionAnimation,
  );
  const [captionOffsetSeconds, setCaptionOffsetSeconds] = useState(
    initialDraft.captionOffsetSeconds ?? 0,
  );
  const [clipStrategy, setClipStrategy] = useState(
    initialDraft.clipStrategy ?? "",
  );
  const [captions, setCaptions] = useState<CaptionBlock[]>(
    initialDraft.captions,
  );
  const [timedTranscriptSegments, setTimedTranscriptSegments] = useState<
    TimedTranscriptSegment[]
  >([]);
  const [timedTranscriptWords, setTimedTranscriptWords] = useState<
    TimedTranscriptWord[]
  >([]);
  const [hasManualCaptionEdits, setHasManualCaptionEdits] = useState(false);
  const [voiceoverUploadFile, setVoiceoverUploadFile] = useState<File | null>(
    null,
  );
  const [clipPreviewUrl, setClipPreviewUrl] = useState("");
  const [voiceoverPreviewUrl, setVoiceoverPreviewUrl] = useState("");
  const [musicPreviewUrl, setMusicPreviewUrl] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentSecond, setCurrentSecond] = useState(0);
  const [duration, setDuration] = useState(0);
  const [voiceoverDuration, setVoiceoverDuration] = useState(0);
  const [musicVolume, setMusicVolume] = useState(35);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState("");
  const [autoClips, setAutoClips] = useState<AutoClipItem[]>([]);
  const [isAutoGenerating, setIsAutoGenerating] = useState(false);
  const [autoClipError, setAutoClipError] = useState("");
  const [autoSequenceLocked, setAutoSequenceLocked] = useState(false);
  const [autoSequenceIndex, setAutoSequenceIndex] = useState(0);
  const [autoPlayRequested, setAutoPlayRequested] = useState(false);
  const [isMergingAutoClips, setIsMergingAutoClips] = useState(false);
  const [isRenderingOutput, setIsRenderingOutput] = useState(false);
  const [isPlanningClips, setIsPlanningClips] = useState(false);
  const [autoGenerateStage, setAutoGenerateStage] = useState<
    "" | "planning" | "finding" | "merging"
  >("");
  const [stepError, setStepError] = useState("");
  const [currentStep, setCurrentStep] = useState(1);
  const [maxStepReached, setMaxStepReached] = useState(1);
  const [ideaLocked, setIdeaLocked] = useState(false);

  const getSequenceOffset = (index: number): number =>
    autoClips
      .slice(0, Math.max(0, index))
      .reduce((sum, clip) => sum + Math.max(1, clip.durationSeconds), 0);

  useEffect(() => {
    setMaxStepReached((prev) => Math.max(prev, currentStep));
  }, [currentStep]);

  useEffect(() => {
    const payload = {
      reelTitle,
      clipSource,
      remoteClipUrl,
      muteClipAudio,
      voiceoverName,
      musicName,
      hasMusic,
      captionSeedText,
      captionPosition,
      captionStyle,
      captionAnimation,
      captionOffsetSeconds,
      clipStrategy,
      captions,
    };
    localStorage.setItem("anime-reel-studio-draft", JSON.stringify(payload));
  }, [
    reelTitle,
    clipSource,
    remoteClipUrl,
    muteClipAudio,
    voiceoverName,
    musicName,
    hasMusic,
    captionSeedText,
    captionPosition,
    captionStyle,
    captionAnimation,
    captionOffsetSeconds,
    clipStrategy,
    captions,
  ]);

  useEffect(() => {
    return () => {
      if (clipObjectUrlRef.current)
        URL.revokeObjectURL(clipObjectUrlRef.current);
      if (voiceObjectUrlRef.current)
        URL.revokeObjectURL(voiceObjectUrlRef.current);
      if (musicObjectUrlRef.current)
        URL.revokeObjectURL(musicObjectUrlRef.current);
      if (mergedClipUrlRef.current)
        URL.revokeObjectURL(mergedClipUrlRef.current);
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [savedClip, savedVoice, savedMusic] = await Promise.all([
          readMediaRecord("clip"),
          readMediaRecord("voiceover"),
          readMediaRecord("music"),
        ]);

        if (savedClip) {
          if (clipObjectUrlRef.current)
            URL.revokeObjectURL(clipObjectUrlRef.current);
          const clipUrl = URL.createObjectURL(savedClip.blob);
          clipObjectUrlRef.current = clipUrl;
          setClipPreviewUrl(clipUrl);
          setClipSource(savedClip.name);
        }

        if (savedVoice) {
          if (voiceObjectUrlRef.current)
            URL.revokeObjectURL(voiceObjectUrlRef.current);
          const voiceUrl = URL.createObjectURL(savedVoice.blob);
          voiceObjectUrlRef.current = voiceUrl;
          setVoiceoverPreviewUrl(voiceUrl);
          setVoiceoverName(savedVoice.name);
          setVoiceoverUploadFile(
            new File([savedVoice.blob], savedVoice.name, {
              type: savedVoice.type,
            }),
          );
        }

        if (savedMusic) {
          if (musicObjectUrlRef.current)
            URL.revokeObjectURL(musicObjectUrlRef.current);
          const musicUrl = URL.createObjectURL(savedMusic.blob);
          musicObjectUrlRef.current = musicUrl;
          setMusicPreviewUrl(musicUrl);
          setMusicName(savedMusic.name);
        }
      } catch {
        // ignore restore errors and let user keep editing
      }
    })();
  }, []);

  useEffect(() => {
    if (musicTrackRef.current) {
      musicTrackRef.current.volume = musicVolume / 100;
    }
  }, [musicVolume]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = muteClipAudio;
    }
  }, [muteClipAudio]);

  const clipPlaybackUrl = useMemo(() => {
    if (clipPreviewUrl) return clipPreviewUrl;
    if (remoteClipUrl) return remoteClipUrl;
    if (clipSource.startsWith("http://") || clipSource.startsWith("https://")) {
      return clipSource;
    }
    return "";
  }, [clipPreviewUrl, remoteClipUrl, clipSource]);

  const currentCaption = useMemo(() => {
    const playbackTime = currentSecond + captionOffsetSeconds;
    return (
      captions.find((caption) => {
        const start = parseTimestampToSeconds(caption.start);
        const end = parseTimestampToSeconds(caption.end);
        return playbackTime >= start && playbackTime <= end;
      })?.text ?? ""
    );
  }, [captions, currentSecond, captionOffsetSeconds]);

  const captionPositionClass = useMemo(() => {
    if (captionPosition === "top-center")
      return "top-4 left-1/2 -translate-x-1/2";
    if (captionPosition === "middle-center")
      return "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2";
    return "bottom-4 left-1/2 -translate-x-1/2";
  }, [captionPosition]);

  const captionStyleClass = useMemo(() => {
    if (captionStyle === "clean-minimal") {
      return "bg-black/40 px-3 py-1.5 text-base font-medium tracking-wide text-[#F5F5F5]";
    }
    if (captionStyle === "pop-neon") {
      return "bg-black/65 px-4 py-2 text-base font-bold uppercase text-[#F5F5F5] shadow-[0_0_24px_rgba(245,245,245,0.25)]";
    }
    return "bg-black/70 px-4 py-2 text-lg font-black uppercase tracking-wide text-[#F5F5F5]";
  }, [captionStyle]);

  const handleTimelineScrub = (value: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = value;
    setCurrentSecond(value);
    if (voiceTrackRef.current) {
      voiceTrackRef.current.currentTime = value;
    }
    if (musicTrackRef.current) {
      musicTrackRef.current.currentTime = value;
    }
  };

  const togglePlayback = async () => {
    if (!videoRef.current) return;
    if (!clipPlaybackUrl && autoSequenceLocked && autoClips.length > 0) {
      await mergeAutoClipsToSingleVideo(autoClips, { autoplay: true });
      return;
    }

    const hasVoiceTrack = Boolean(voiceoverPreviewUrl && voiceTrackRef.current);
    if (isPlaying) {
      videoRef.current.pause();
      voiceTrackRef.current?.pause();
      musicTrackRef.current?.pause();
      setIsPlaying(false);
      return;
    }

    try {
      const startTime =
        (hasVoiceTrack
          ? voiceTrackRef.current?.currentTime
          : videoRef.current.currentTime) ?? currentSecond;

      if (voiceTrackRef.current && hasVoiceTrack) {
        voiceTrackRef.current.currentTime = startTime;
        await voiceTrackRef.current.play();
      }

      videoRef.current.currentTime = startTime;
      await videoRef.current.play();

      if (musicTrackRef.current && hasMusic && musicPreviewUrl) {
        musicTrackRef.current.currentTime = startTime;
        void musicTrackRef.current.play().catch(() => {});
      }

      setCurrentSecond(startTime);
      setIsPlaying(true);
    } catch {
      setIsPlaying(false);
    }
  };

  const buildCaptionsFromCurrentTranscript = (
    text: string,
    options?: {
      words?: TimedTranscriptWord[];
      segments?: TimedTranscriptSegment[];
    },
  ) => {
    const sourceWords = options?.words ?? timedTranscriptWords;
    const sourceSegments = options?.segments ?? timedTranscriptSegments;
    const transcriptTimelineDuration = inferTranscriptTimelineDuration(
      sourceWords,
      sourceSegments,
    );
    const targetDuration =
      voiceoverDuration > 0 ? voiceoverDuration : transcriptTimelineDuration;
    setCaptions(
      buildCaptionBlocksFromTimedTranscript(
        text,
        sourceWords,
        sourceSegments,
        targetDuration,
      ),
    );
    setHasManualCaptionEdits(false);
  };

  const getAudioDurationFromFile = async (file: File): Promise<number> =>
    new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const audio = new Audio(url);
      audio.preload = "metadata";
      audio.onloadedmetadata = () => {
        const value = Number(audio.duration || 0);
        URL.revokeObjectURL(url);
        resolve(Number.isFinite(value) ? value : 0);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(0);
      };
    });

  const planClipsFromIdeaAndTranscript = async (
    coreIdea: string,
    transcript: string,
  ): Promise<string> => {
    setIsPlanningClips(true);
    try {
      const response = await fetch("/api/reel-plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ coreIdea, transcript }),
      });
      const payload = (await response.json()) as {
        strategy?: string;
        error?: string;
      };
      if (!response.ok || !payload.strategy) {
        throw new Error(payload.error ?? "could not create clip strategy");
      }
      setClipStrategy(payload.strategy);
      return payload.strategy;
    } finally {
      setIsPlanningClips(false);
    }
  };

  const transcribeVoiceover = async (
    fileOverride?: File,
  ): Promise<string | null> => {
    const file = fileOverride ?? voiceoverUploadFile;
    if (!file) return null;
    setIsTranscribing(true);
    setTranscribeError("");

    try {
      const formData = new FormData();
      formData.append("audio", file);

      const controller = new AbortController();
      const timeout = window.setTimeout(
        () => controller.abort(),
        resolveTranscribeTimeoutMs(),
      );
      const response = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      }).finally(() => {
        window.clearTimeout(timeout);
      });
      const transcribeRequestId =
        response.headers.get("x-transcribe-request-id") ?? "unknown";

      const payload = (await response.json()) as {
        text?: string;
        segments?: TimedTranscriptSegment[];
        words?: TimedTranscriptWord[];
        alignment?: "whisper";
        error?: string;
      };
      console.log("[transcribe-ui]", {
        requestId: transcribeRequestId,
        ok: response.ok,
        alignment: payload.alignment ?? "unknown",
      });
      if (!response.ok || !payload.text) {
        setTranscribeError(payload.error ?? "transcription failed");
        return null;
      }

      const segments = Array.isArray(payload.segments) ? payload.segments : [];
      const words = Array.isArray(payload.words) ? payload.words : [];
      setTimedTranscriptSegments(segments);
      setTimedTranscriptWords(words);
      setCaptionSeedText(payload.text);
      buildCaptionsFromCurrentTranscript(payload.text, { words, segments });
      return payload.text;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        setTranscribeError(
          "transcription is taking too long. try again, or shorten the audio.",
        );
      } else {
        setTranscribeError(
          "couldn't transcribe right now. try again in a second.",
        );
      }
      return null;
    } finally {
      setIsTranscribing(false);
    }
  };

  const completeIdeaStep = () => {
    if (!reelTitle.trim()) {
      setStepError("add the core reel idea first.");
      return;
    }
    setStepError("");
    setIdeaLocked(true);
    setCurrentStep(2);
  };

  const handleVoiceoverPicked = async (file: File) => {
    if (voiceObjectUrlRef.current)
      URL.revokeObjectURL(voiceObjectUrlRef.current);
    const nextUrl = URL.createObjectURL(file);
    voiceObjectUrlRef.current = nextUrl;
    setVoiceoverPreviewUrl(nextUrl);
    setVoiceoverName(file.name);
    setVoiceoverUploadFile(file);
    void saveMediaRecord("voiceover", {
      name: file.name,
      blob: file,
      type: file.type,
    });

    const detectedDuration = await getAudioDurationFromFile(file);
    if (detectedDuration > 0) {
      setVoiceoverDuration(detectedDuration);
    }

    const transcript = await transcribeVoiceover(file);
    if (!transcript) return;

    setClipStrategy("");
    setStepError("");
    setCurrentStep(3);
  };

  const triggerAutoClipGeneration = async (
    count?: number,
    targetSeconds?: number,
    strategyOverride?: string,
  ) => {
    if (!captionSeedText.trim()) {
      setAutoClipError(
        "add or transcribe captions first so i can match the vibe.",
      );
      return [];
    }
    const activeStrategy = strategyOverride?.trim() || clipStrategy.trim();
    if (!activeStrategy) {
      setAutoClipError("could not create clip strategy right now.");
      return [];
    }

    setIsAutoGenerating(true);
    setAutoClipError("");

    try {
      const response = await fetch("/api/auto-clips", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transcript: captionSeedText,
          strategy: `${reelTitle}\n${activeStrategy}`,
          targetDurationSeconds:
            targetSeconds ??
            Math.max(8, Math.floor(voiceoverDuration || duration || 20)),
          count,
          excludeClipIds: autoClips.map((clip) => clip.id),
        }),
      });

      const payload = (await response.json()) as {
        query?: string;
        clips?: Array<
          Omit<AutoClipItem, "replaceOnRegenerate"> & {
            segmentId: string;
          }
        >;
        error?: string;
      };

      if (!response.ok || !Array.isArray(payload.clips)) {
        setAutoClipError(payload.error ?? "could not generate clips right now");
        return [];
      }

      return payload.clips.map((clip) => ({
        ...clip,
        replaceOnRegenerate: false,
      }));
    } catch {
      setAutoClipError("could not generate clips right now");
      return [];
    } finally {
      setIsAutoGenerating(false);
    }
  };

  const mergeAutoClipsToSingleVideo = async (
    clips: AutoClipItem[],
    options?: { autoplay?: boolean },
  ) => {
    if (!clips.length) return false;
    setIsMergingAutoClips(true);
    setAutoClipError("");

    try {
      const response = await fetchMediaWithDirectFallback("/api/merge-clips", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clips: clips.map((clip) => ({
            streamUrl: clip.streamUrl,
            refererUrl: clip.refererUrl,
          })),
          targetDurationSeconds:
            voiceoverDuration > 0 ? voiceoverDuration : undefined,
          maxOverrunSeconds: 3,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          details?: {
            requested?: number;
            downloaded?: number;
            downloadFailures?: number;
            probeFailures?: number;
            normalizeFailures?: number;
            lastDownloadError?: string;
            mergeError?: string;
            fallbackMessage?: string;
            requestId?: string;
            message?: string;
          };
        };
        const detailsText = payload.details
          ? ` (requested: ${payload.details.requested ?? 0}, usable: ${payload.details.downloaded ?? 0}, download fails: ${payload.details.downloadFailures ?? 0}, normalize fails: ${payload.details.normalizeFailures ?? payload.details.probeFailures ?? 0}${payload.details.lastDownloadError ? `, last: ${payload.details.lastDownloadError}` : ""}${payload.details.mergeError ? `, merge: ${payload.details.mergeError}` : ""}${payload.details.fallbackMessage ? `, fallback: ${payload.details.fallbackMessage}` : ""}${payload.details.message ? `, message: ${payload.details.message}` : ""}${payload.details.requestId ? `, requestId: ${payload.details.requestId}` : ""})`
          : "";
        setAutoClipError(
          `${payload.error ?? "could not stitch clips right now"}${detailsText}`,
        );
        return false;
      }

      const mergedBlob = await response.blob();
      if (!mergedBlob.size) {
        setAutoClipError("could not stitch clips right now");
        return false;
      }

      if (mergedClipUrlRef.current) {
        URL.revokeObjectURL(mergedClipUrlRef.current);
      }
      const mergedUrl = URL.createObjectURL(mergedBlob);
      mergedClipUrlRef.current = mergedUrl;

      setAutoSequenceLocked(false);
      setAutoSequenceIndex(0);
      setClipPreviewUrl(mergedUrl);
      setRemoteClipUrl("");
      setClipSource("stitched-anime-reel.mp4");
      setCurrentSecond(0);
      setDuration(
        clips.reduce((sum, clip) => sum + Math.max(1, clip.durationSeconds), 0),
      );
      setAutoPlayRequested(Boolean(options?.autoplay));

      if (voiceTrackRef.current) {
        voiceTrackRef.current.currentTime = 0;
      }
      if (musicTrackRef.current) {
        musicTrackRef.current.currentTime = 0;
      }

      return true;
    } catch {
      setAutoClipError("could not stitch clips right now");
      return false;
    } finally {
      setIsMergingAutoClips(false);
    }
  };

  const setRemoteClipForPreview = (
    streamUrl: string,
    name: string,
    options?: {
      autoplay?: boolean;
      lockSequence?: boolean;
      refererUrl?: string;
    },
  ) => {
    if (options?.lockSequence === false) {
      setAutoSequenceLocked(false);
    }
    setClipPreviewUrl("");
    setRemoteClipUrl(toPlayableUrl(streamUrl, options?.refererUrl));
    setClipSource(name);
    setCurrentSecond(0);
    setAutoPlayRequested(Boolean(options?.autoplay));
  };

  const generateAutoClips = async () => {
    if (!captionSeedText.trim()) {
      setAutoClipError(
        "upload and transcribe the voiceover first so i can auto-generate clips.",
      );
      return;
    }

    setAutoClipError("");
    setAutoGenerateStage("planning");
    try {
      const strategy = await planClipsFromIdeaAndTranscript(
        reelTitle,
        captionSeedText,
      );
      setClipStrategy(strategy);

      setAutoGenerateStage("finding");
      const generated = await triggerAutoClipGeneration(
        undefined,
        undefined,
        strategy,
      );
      if (!generated.length) return;
      setAutoClips(generated);

      setAutoGenerateStage("merging");
      const merged = await mergeAutoClipsToSingleVideo(generated);
      if (merged) {
        setCurrentStep(4);
      }
    } catch {
      setAutoClipError("could not create clip strategy right now");
    } finally {
      setAutoGenerateStage("");
    }
  };

  const handleManualVideoPicked = (nextFile: File) => {
    if (clipObjectUrlRef.current) URL.revokeObjectURL(clipObjectUrlRef.current);
    const nextUrl = URL.createObjectURL(nextFile);
    clipObjectUrlRef.current = nextUrl;
    setClipPreviewUrl(nextUrl);
    setRemoteClipUrl("");
    setClipSource(nextFile.name);
    void saveMediaRecord("clip", {
      name: nextFile.name,
      blob: nextFile,
      type: nextFile.type,
    });
    setCurrentStep(4);
  };

  const regenerateSelectedClips = async () => {
    if (!autoClips.length) return;
    const targets = autoClips.filter((clip) => clip.replaceOnRegenerate);
    const selected = targets.length ? targets : autoClips;
    const totalDuration = selected.reduce(
      (sum, clip) => sum + clip.durationSeconds,
      0,
    );
    const replacements = await triggerAutoClipGeneration(
      selected.length,
      totalDuration,
    );
    if (!replacements.length) return;

    let replacementIndex = 0;
    const replaceAll = targets.length === 0;
    const nextClips = autoClips.map((clip) => {
      if (replaceAll || clip.replaceOnRegenerate) {
        const replacement = replacements[replacementIndex];
        replacementIndex += 1;
        return replacement
          ? { ...replacement, replaceOnRegenerate: false }
          : clip;
      }
      return clip;
    });

    setAutoClips(nextClips);
    const merged = await mergeAutoClipsToSingleVideo(nextClips);
    if (merged) {
      setCurrentStep(4);
    }
  };

  const selectedPosition = useMemo(
    () =>
      captionPositions.find((item) => item.key === captionPosition)?.label ??
      "bottom center",
    [captionPosition],
  );

  const selectedStyle = useMemo(
    () =>
      captionStyles.find((item) => item.key === captionStyle)?.label ??
      "anime bold",
    [captionStyle],
  );

  useEffect(() => {
    if (!captionSeedText.trim()) return;
    if (hasManualCaptionEdits) return;
    if (voiceoverDuration <= 0) return;
    setCaptions(
      buildCaptionBlocksFromTimedTranscript(
        captionSeedText,
        timedTranscriptWords,
        timedTranscriptSegments,
        voiceoverDuration,
      ),
    );
  }, [
    voiceoverDuration,
    captionSeedText,
    hasManualCaptionEdits,
    timedTranscriptWords,
    timedTranscriptSegments,
  ]);

  const autoSequenceOffset = autoSequenceLocked
    ? getSequenceOffset(autoSequenceIndex)
    : 0;
  const playbackElapsed = currentSecond + autoSequenceOffset;

  const steps = [
    { id: 1, title: "core idea" },
    { id: 2, title: "voiceover" },
    { id: 3, title: "clips" },
    { id: 4, title: "preview + captions" },
  ] as const;

  const downloadPreviewVideo = async () => {
    if (!clipPlaybackUrl) return;
    try {
      setIsRenderingOutput(true);
      const videoBlob = await (await fetch(clipPlaybackUrl)).blob();
      const formData = new FormData();
      formData.append(
        "video",
        new File([videoBlob], "preview.mp4", { type: "video/mp4" }),
      );
      formData.append("muteOriginalAudio", muteClipAudio ? "true" : "false");
      formData.append("musicVolume", String(musicVolume));
      formData.append("captions", JSON.stringify(captions));
      formData.append("captionPosition", captionPosition);
      formData.append("captionStyle", captionStyle);
      formData.append("captionAnimation", captionAnimation ? "true" : "false");
      formData.append("captionOffsetSeconds", String(captionOffsetSeconds));

      if (voiceoverUploadFile) {
        formData.append("voiceover", voiceoverUploadFile);
      }
      if (hasMusic && musicPreviewUrl) {
        const musicBlob = await (await fetch(musicPreviewUrl)).blob();
        formData.append(
          "music",
          new File([musicBlob], musicName || "music.mp3", {
            type: musicBlob.type || "audio/mpeg",
          }),
        );
      }

      const renderedResponse = await fetchMediaWithDirectFallback(
        "/api/render-reel",
        {
          method: "POST",
          body: formData,
        },
      );
      if (!renderedResponse.ok) {
        const payload = (await renderedResponse.json().catch(() => ({}))) as {
          error?: string;
        };
        setStepError(
          payload.error ?? "could not render output video right now.",
        );
        return;
      }

      const renderedBlob = await renderedResponse.blob();
      const url = URL.createObjectURL(renderedBlob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${(reelTitle || "anime-reel").replace(/[^\w-]+/g, "-")}.mp4`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStepError("");
    } catch {
      setStepError("could not download the current output.");
    } finally {
      setIsRenderingOutput(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#1C1C1C] p-5 font-sans text-[#F5F5F5]/70 sm:p-8">
      <motion.div
        className="mx-auto flex w-full max-w-5xl flex-col gap-5"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold text-[#F5F5F5] sm:text-4xl">
              anime reel builder
            </h1>
          </div>
        </div>

        <Card className="border border-white/10 bg-white/5 text-[#F5F5F5]/70 backdrop-blur-md">
          <CardBody className="grid gap-3 sm:grid-cols-4">
            {steps.map((step) => {
              const isCurrent = step.id === currentStep;
              const isPast = step.id < currentStep;
              const isReachable = step.id <= maxStepReached;
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => {
                    if (isReachable) setCurrentStep(step.id);
                  }}
                  className={`rounded-xl border px-3 py-2 text-left transition ${
                    isCurrent
                      ? "border-white/40 bg-white/15 text-[#F5F5F5]"
                      : isPast
                        ? "border-white/20 bg-white/10 text-[#F5F5F5]/80"
                        : "border-white/10 bg-black/30 text-[#F5F5F5]/40"
                  } ${isReachable ? "cursor-pointer" : "cursor-not-allowed"}`}
                >
                  <p className="text-xs uppercase tracking-wide">
                    step {step.id}
                  </p>
                  <p className="text-sm">{step.title}</p>
                </button>
              );
            })}
          </CardBody>
        </Card>

        {stepError ? (
          <p className="text-sm text-red-300/80">{stepError}</p>
        ) : null}

        {currentStep === 1 ? (
          <Card className="border border-white/10 bg-white/5 text-[#F5F5F5]/70 backdrop-blur-md">
            <CardHeader className="text-lg font-semibold text-[#F5F5F5]">
              step 1: core idea
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              <Textarea
                label="what is the message of this reel?"
                labelPlacement="outside"
                minRows={3}
                placeholder="e.g. first they’ll doubt, then they’ll applaud"
                value={reelTitle}
                onValueChange={setReelTitle}
                classNames={fieldClassNames}
              />
              <div className="flex items-center gap-2">
                <Button className={buttonClassName} onPress={completeIdeaStep}>
                  continue
                </Button>
              </div>
            </CardBody>
          </Card>
        ) : null}

        {currentStep === 2 ? (
          <Card className="border border-white/10 bg-white/5 text-[#F5F5F5]/70 backdrop-blur-md">
            <CardHeader className="text-lg font-semibold text-[#F5F5F5]">
              step 2: voiceover
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={voiceoverInputRef}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(event) => {
                    const nextFile = event.target.files?.[0] ?? null;
                    if (!nextFile) return;
                    void handleVoiceoverPicked(nextFile);
                  }}
                />
                <button
                  type="button"
                  className="w-full rounded-lg border border-dashed border-white/25 bg-black/20 p-5 text-center text-sm text-[#F5F5F5]/70 transition hover:bg-black/30"
                  onClick={() => voiceoverInputRef.current?.click()}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const dropped = event.dataTransfer.files?.[0];
                    if (dropped) void handleVoiceoverPicked(dropped);
                  }}
                >
                  drag and drop voiceover audio here, or click to upload
                </button>
                <Chip
                  size="sm"
                  variant="bordered"
                  className="border-white/20 text-[#F5F5F5]/70"
                >
                  {voiceoverName
                    ? truncateFileName(voiceoverName)
                    : "no voiceover yet"}
                </Chip>
              </div>

              {isTranscribing ? (
                <StatusCallout
                  tone="progress"
                  title="transcribing voiceover..."
                  description="this can take a moment depending on audio length."
                />
              ) : null}
              {transcribeError ? (
                <p className="text-sm text-red-300/80">{transcribeError}</p>
              ) : null}

              <Textarea
                label="transcript"
                labelPlacement="outside"
                minRows={4}
                value={captionSeedText}
                onValueChange={setCaptionSeedText}
                classNames={fieldClassNames}
              />
              <div className="flex items-center gap-2">
                <Button
                  className={buttonClassName}
                  onPress={() => setCurrentStep(1)}
                >
                  back
                </Button>
                <Button
                  className={buttonClassName}
                  onPress={() => setCurrentStep(3)}
                  isDisabled={!ideaLocked || !captionSeedText.trim()}
                >
                  continue
                </Button>
              </div>
            </CardBody>
          </Card>
        ) : null}

        {currentStep === 3 ? (
          <Card className="border border-white/10 bg-white/5 text-[#F5F5F5]/70 backdrop-blur-md">
            <CardHeader className="text-lg font-semibold text-[#F5F5F5]">
              step 3: choose video source
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
              <p className="text-sm text-[#F5F5F5]/70">
                upload your own video or auto-generate anime clips.
              </p>
              <StatusCallout
                tone="warning"
                title="auto-generation can take anywhere between 5-10 mins."
                description="keep this tab open while we plan, find, and merge clips."
              />

              <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-black/30 p-3">
                <input
                  ref={clipInputRef}
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={(event) => {
                    const nextFile = event.target.files?.[0] ?? null;
                    if (!nextFile) return;
                    handleManualVideoPicked(nextFile);
                  }}
                />
                <button
                  type="button"
                  className="rounded-lg border border-dashed border-white/25 bg-black/20 p-5 text-center text-sm text-[#F5F5F5]/70 transition hover:bg-black/30"
                  onClick={() => clipInputRef.current?.click()}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const dropped = event.dataTransfer.files?.[0];
                    if (dropped) handleManualVideoPicked(dropped);
                  }}
                >
                  drag and drop a video here, or click to upload
                </button>
                <div className="flex items-center gap-3">
                  <div className="h-px flex-1 bg-white/15" />
                  <p className="text-xs uppercase tracking-widest text-[#F5F5F5]/60">
                    or
                  </p>
                  <div className="h-px flex-1 bg-white/15" />
                </div>
                <Button
                  className={buttonClassName}
                  onPress={generateAutoClips}
                  isDisabled={
                    isPlanningClips || isAutoGenerating || isMergingAutoClips
                  }
                >
                  auto-generate
                </Button>
                {autoGenerateStage ? (
                  <StatusCallout
                    tone="progress"
                    title={
                      autoGenerateStage === "planning"
                        ? "planning clip strategy..."
                        : autoGenerateStage === "finding"
                          ? "finding anime clips..."
                          : "merging anime clips..."
                    }
                    description={
                      autoGenerateStage === "planning"
                        ? "analyzing your idea + transcript to map visual direction."
                        : autoGenerateStage === "finding"
                          ? "searching and filtering clips that match the vibe."
                          : "stitching clips into one final preview video."
                    }
                  />
                ) : null}
              </div>
              {autoClips.length > 0 ? (
                <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      className={buttonClassName}
                      onPress={regenerateSelectedClips}
                      isDisabled={
                        !autoClips.length ||
                        isAutoGenerating ||
                        isMergingAutoClips
                      }
                    >
                      regenerate selected
                    </Button>
                  </div>
                  <div className="mt-3 grid max-h-56 gap-2 overflow-auto pr-1">
                    {autoClips.map((clip, index) => (
                      <div
                        key={clip.segmentId}
                        className="rounded-lg border border-white/10 bg-black/20 p-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm text-[#F5F5F5]/70">
                            {index + 1}. {truncateFileName(clip.name, 36)}
                          </p>
                          <Button
                            className={buttonClassName}
                            onPress={() => {
                              setRemoteClipForPreview(
                                clip.streamUrl,
                                clip.name,
                                {
                                  autoplay: true,
                                  lockSequence: false,
                                  refererUrl: clip.refererUrl,
                                },
                              );
                            }}
                          >
                            preview
                          </Button>
                        </div>
                        <Checkbox
                          isSelected={clip.replaceOnRegenerate}
                          onValueChange={(value) =>
                            setAutoClips((prev) =>
                              prev.map((item) =>
                                item.segmentId === clip.segmentId
                                  ? { ...item, replaceOnRegenerate: value }
                                  : item,
                              ),
                            )
                          }
                          classNames={{ label: "text-[#F5F5F5]/70" }}
                        >
                          replace this on regenerate
                        </Checkbox>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {autoClipError ? (
                <p className="mt-2 text-sm text-red-300/80">{autoClipError}</p>
              ) : null}
              <div className="flex items-center gap-2">
                <Button
                  className={buttonClassName}
                  onPress={() => setCurrentStep(2)}
                >
                  back
                </Button>
                <Button
                  className={buttonClassName}
                  onPress={() => setCurrentStep(4)}
                  isDisabled={!clipPlaybackUrl}
                >
                  continue
                </Button>
              </div>
            </CardBody>
          </Card>
        ) : null}

        {currentStep === 4 ? (
          <>
            <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
              <Card className="border border-white/10 bg-white/5 text-[#F5F5F5]/70 backdrop-blur-md">
                <CardHeader className="text-lg font-semibold text-[#F5F5F5]">
                  reel preview
                </CardHeader>
                <CardBody className="flex flex-col gap-4">
                  <div className="relative mx-auto w-full max-w-[320px] overflow-hidden rounded-xl border border-white/10 bg-black/50 sm:max-w-[360px]">
                    {clipPlaybackUrl ? (
                      <video
                        ref={videoRef}
                        src={clipPlaybackUrl}
                        className="mx-auto aspect-[9/16] w-full object-contain bg-black"
                        playsInline
                        muted={muteClipAudio}
                        onLoadedMetadata={(event) =>
                          setDuration(event.currentTarget.duration || 0)
                        }
                        onLoadedData={async () => {
                          if (!autoPlayRequested) return;
                          try {
                            await videoRef.current?.play();
                            setIsPlaying(true);
                          } catch {
                            setIsPlaying(false);
                          } finally {
                            setAutoPlayRequested(false);
                          }
                        }}
                        onPlay={() => setIsPlaying(true)}
                        onPause={() => setIsPlaying(false)}
                        onTimeUpdate={(event) => {
                          const videoTime = event.currentTarget.currentTime;
                          const masterTime =
                            voiceoverPreviewUrl && voiceTrackRef.current
                              ? voiceTrackRef.current.currentTime
                              : videoTime;

                          setCurrentSecond(masterTime);

                          if (voiceoverPreviewUrl && voiceTrackRef.current) {
                            const drift = Math.abs(videoTime - masterTime);
                            if (drift > 0.2) {
                              event.currentTarget.currentTime = masterTime;
                            }
                          }

                          if (
                            musicTrackRef.current &&
                            !musicTrackRef.current.paused
                          ) {
                            const delta = Math.abs(
                              musicTrackRef.current.currentTime - masterTime,
                            );
                            if (delta > 0.2) {
                              musicTrackRef.current.currentTime = masterTime;
                            }
                          }
                        }}
                      />
                    ) : (
                      <div className="mx-auto aspect-[9/16] w-full p-6 text-center text-sm text-[#F5F5F5]/70">
                        no clip yet
                      </div>
                    )}
                    {currentCaption ? (
                      <div
                        className={`pointer-events-none absolute ${captionPositionClass} ${captionAnimation ? "animate-pulse" : ""}`}
                      >
                        <p
                          className={`max-w-[90vw] rounded-xl text-center sm:max-w-md ${captionStyleClass}`}
                        >
                          {currentCaption}
                        </p>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      className={buttonClassName}
                      onPress={togglePlayback}
                      isDisabled={!clipPlaybackUrl}
                    >
                      {isPlaying ? "pause preview" : "play preview"}
                    </Button>
                    <Button
                      className={buttonClassName}
                      onPress={downloadPreviewVideo}
                      isDisabled={!clipPlaybackUrl || isRenderingOutput}
                    >
                      download video
                    </Button>
                    <Chip
                      size="sm"
                      variant="bordered"
                      className="border-white/20 text-[#F5F5F5]/70"
                    >
                      {formatSecondsToTimestamp(playbackElapsed)} /{" "}
                      {formatSecondsToTimestamp(duration)}
                    </Chip>
                  </div>
                  {isRenderingOutput ? (
                    <StatusCallout
                      tone="progress"
                      title="rendering output video..."
                      description="finalizing the merged export with your current settings."
                    />
                  ) : null}
                  <input
                    type="range"
                    min={0}
                    max={Math.max(duration, 0)}
                    step={0.1}
                    value={Math.min(playbackElapsed, duration || currentSecond)}
                    onChange={(event) =>
                      handleTimelineScrub(Number(event.target.value))
                    }
                    disabled={!clipPlaybackUrl}
                  />
                </CardBody>
              </Card>

              <Card className="border border-white/10 bg-white/5 text-[#F5F5F5]/70 backdrop-blur-md">
                <CardHeader className="text-lg font-semibold text-[#F5F5F5]">
                  caption + audio styling
                </CardHeader>
                <CardBody className="flex flex-col gap-4">
                  <Select
                    label="caption position"
                    labelPlacement="outside"
                    selectedKeys={[captionPosition]}
                    onSelectionChange={(keys) =>
                      setCaptionPosition(
                        String(Array.from(keys)[0] ?? "bottom-center"),
                      )
                    }
                    classNames={selectClassNames}
                    renderValue={(items) => (
                      <span className="text-[#F5F5F5]/70">
                        {items.map((item) => item.textValue).join(", ")}
                      </span>
                    )}
                  >
                    {captionPositions.map((item) => (
                      <SelectItem
                        key={item.key}
                        className="text-[#F5F5F5]/70 data-[hover=true]:bg-white/10 data-[selectable=true]:focus:bg-white/10"
                        classNames={{ title: "text-[#F5F5F5]/70" }}
                      >
                        {item.label}
                      </SelectItem>
                    ))}
                  </Select>
                  <Select
                    label="caption style"
                    labelPlacement="outside"
                    selectedKeys={[captionStyle]}
                    onSelectionChange={(keys) =>
                      setCaptionStyle(
                        String(Array.from(keys)[0] ?? "anime-bold"),
                      )
                    }
                    classNames={selectClassNames}
                    renderValue={(items) => (
                      <span className="text-[#F5F5F5]/70">
                        {items.map((item) => item.textValue).join(", ")}
                      </span>
                    )}
                  >
                    {captionStyles.map((item) => (
                      <SelectItem
                        key={item.key}
                        className="text-[#F5F5F5]/70 data-[hover=true]:bg-white/10 data-[selectable=true]:focus:bg-white/10"
                        classNames={{ title: "text-[#F5F5F5]/70" }}
                      >
                        {item.label}
                      </SelectItem>
                    ))}
                  </Select>
                  <Switch
                    isSelected={captionAnimation}
                    onValueChange={setCaptionAnimation}
                    classNames={{ label: "text-[#F5F5F5]/70" }}
                  >
                    animate caption entry
                  </Switch>
                  <Switch
                    isSelected={muteClipAudio}
                    onValueChange={setMuteClipAudio}
                    classNames={{ label: "text-[#F5F5F5]/70" }}
                  >
                    mute original clip audio
                  </Switch>
                  <Switch
                    isSelected={hasMusic}
                    onValueChange={setHasMusic}
                    classNames={{ label: "text-[#F5F5F5]/70" }}
                  >
                    add background music
                  </Switch>
                  {hasMusic ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        ref={musicInputRef}
                        type="file"
                        accept="audio/*"
                        className="hidden"
                        onChange={(event) => {
                          const nextFile = event.target.files?.[0] ?? null;
                          if (!nextFile) return;
                          if (musicObjectUrlRef.current)
                            URL.revokeObjectURL(musicObjectUrlRef.current);
                          const nextUrl = URL.createObjectURL(nextFile);
                          musicObjectUrlRef.current = nextUrl;
                          setMusicPreviewUrl(nextUrl);
                          setMusicName(nextFile.name);
                          void saveMediaRecord("music", {
                            name: nextFile.name,
                            blob: nextFile,
                            type: nextFile.type,
                          });
                        }}
                      />
                      <Button
                        className={buttonClassName}
                        onPress={() => musicInputRef.current?.click()}
                      >
                        upload music
                      </Button>
                      <Chip
                        size="sm"
                        variant="bordered"
                        className="border-white/20 text-[#F5F5F5]/70"
                      >
                        {musicName
                          ? truncateFileName(musicName)
                          : "no track yet"}
                      </Chip>
                    </div>
                  ) : null}
                  {hasMusic ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm text-[#F5F5F5]/70">
                        music volume ({musicVolume}%)
                      </p>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={musicVolume}
                        onChange={(event) =>
                          setMusicVolume(Number(event.target.value))
                        }
                      />
                    </div>
                  ) : null}
                  <div className="flex flex-col gap-2">
                    <p className="text-sm text-[#F5F5F5]/70">
                      caption sync offset ({captionOffsetSeconds > 0 ? "+" : ""}
                      {captionOffsetSeconds.toFixed(2)}s)
                    </p>
                    <input
                      type="range"
                      min={-1.5}
                      max={1.5}
                      step={0.05}
                      value={captionOffsetSeconds}
                      onChange={(event) =>
                        setCaptionOffsetSeconds(Number(event.target.value))
                      }
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        className={buttonClassName}
                        onPress={() =>
                          setCaptionOffsetSeconds((prev) =>
                            Math.max(-1.5, Number((prev - 0.1).toFixed(2))),
                          )
                        }
                      >
                        -0.1s
                      </Button>
                      <Button
                        className={buttonClassName}
                        onPress={() => setCaptionOffsetSeconds(0)}
                      >
                        reset
                      </Button>
                      <Button
                        className={buttonClassName}
                        onPress={() =>
                          setCaptionOffsetSeconds((prev) =>
                            Math.min(1.5, Number((prev + 0.1).toFixed(2))),
                          )
                        }
                      >
                        +0.1s
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-[#F5F5F5]/70">
                    profile: {selectedPosition} • {selectedStyle} •{" "}
                    {captionAnimation ? "animated" : "static"}
                  </p>
                </CardBody>
              </Card>
            </div>

            <Card className="border border-white/10 bg-white/5 text-[#F5F5F5]/70 backdrop-blur-md">
              <CardHeader className="text-lg font-semibold text-[#F5F5F5]">
                editable caption timeline
              </CardHeader>
              <CardBody className="flex flex-col gap-3">
                {captions.length === 0 ? (
                  <p className="text-sm text-[#F5F5F5]/70">
                    no captions yet. go back to step 2 and upload voiceover.
                  </p>
                ) : (
                  captions.map((item) => (
                    <div
                      key={item.id}
                      className="grid min-w-0 gap-2 rounded-xl border border-white/10 p-3 sm:grid-cols-[minmax(0,1fr)_120px_120px_72px_44px]"
                    >
                      <div className="min-w-0">
                        <Input
                          value={item.text}
                          onValueChange={(value) => {
                            setHasManualCaptionEdits(true);
                            setCaptions((prev) =>
                              prev.map((cap) =>
                                cap.id === item.id
                                  ? { ...cap, text: value }
                                  : cap,
                              ),
                            );
                          }}
                          classNames={fieldClassNames}
                        />
                      </div>
                      <div className="min-w-0">
                        <Input
                          value={item.start}
                          onValueChange={(value) => {
                            setHasManualCaptionEdits(true);
                            setCaptions((prev) =>
                              prev.map((cap) =>
                                cap.id === item.id
                                  ? { ...cap, start: value }
                                  : cap,
                              ),
                            );
                          }}
                          classNames={fieldClassNames}
                        />
                      </div>
                      <div className="min-w-0">
                        <Input
                          value={item.end}
                          onValueChange={(value) => {
                            setHasManualCaptionEdits(true);
                            setCaptions((prev) =>
                              prev.map((cap) =>
                                cap.id === item.id
                                  ? { ...cap, end: value }
                                  : cap,
                              ),
                            );
                          }}
                          classNames={fieldClassNames}
                        />
                      </div>
                      <div className="flex min-w-0 flex-col gap-1">
                        <Button
                          className={`${buttonClassName} min-w-0 px-0 text-xs`}
                          onPress={() => {
                            setHasManualCaptionEdits(true);
                            setCaptions((prev) =>
                              prev.map((cap) =>
                                cap.id === item.id
                                  ? {
                                      ...cap,
                                      start: shiftCaptionTimestamp(
                                        cap.start,
                                        -0.1,
                                      ),
                                      end: shiftCaptionTimestamp(cap.end, -0.1),
                                    }
                                  : cap,
                              ),
                            );
                          }}
                        >
                          -0.1
                        </Button>
                        <Button
                          className={`${buttonClassName} min-w-0 px-0 text-xs`}
                          onPress={() => {
                            setHasManualCaptionEdits(true);
                            setCaptions((prev) =>
                              prev.map((cap) =>
                                cap.id === item.id
                                  ? {
                                      ...cap,
                                      start: shiftCaptionTimestamp(
                                        cap.start,
                                        0.1,
                                      ),
                                      end: shiftCaptionTimestamp(cap.end, 0.1),
                                    }
                                  : cap,
                              ),
                            );
                          }}
                        >
                          +0.1
                        </Button>
                      </div>
                      <Button
                        className={`${buttonClassName} min-w-0 px-0`}
                        onPress={() => {
                          setHasManualCaptionEdits(true);
                          setCaptions((prev) =>
                            prev.filter((cap) => cap.id !== item.id),
                          );
                        }}
                      >
                        x
                      </Button>
                    </div>
                  ))
                )}
                <Button
                  className={buttonClassName}
                  onPress={() => {
                    setHasManualCaptionEdits(true);
                    setCaptions((prev) => [
                      ...prev,
                      {
                        id: `manual-${Date.now()}`,
                        text: "new caption",
                        start: formatCaptionTimestamp(
                          Math.max(currentSecond, 0),
                        ),
                        end: formatCaptionTimestamp(
                          Math.max(currentSecond + 2, 2),
                        ),
                      },
                    ]);
                  }}
                >
                  add caption block
                </Button>
              </CardBody>
            </Card>
          </>
        ) : null}

        {voiceoverPreviewUrl !== "" && (
          <audio
            ref={voiceTrackRef}
            src={voiceoverPreviewUrl}
            preload="auto"
            onTimeUpdate={(event) => {
              const masterTime = event.currentTarget.currentTime;
              setCurrentSecond(masterTime);

              if (videoRef.current) {
                const videoDrift = Math.abs(
                  videoRef.current.currentTime - masterTime,
                );
                if (videoDrift > 0.2) {
                  videoRef.current.currentTime = masterTime;
                }
              }

              if (musicTrackRef.current && !musicTrackRef.current.paused) {
                const musicDrift = Math.abs(
                  musicTrackRef.current.currentTime - masterTime,
                );
                if (musicDrift > 0.2) {
                  musicTrackRef.current.currentTime = masterTime;
                }
              }
            }}
            onEnded={() => {
              videoRef.current?.pause();
              musicTrackRef.current?.pause();
              setIsPlaying(false);
            }}
          />
        )}
        {musicPreviewUrl && musicPreviewUrl !== "" && (
          <audio
            ref={musicTrackRef}
            src={musicPreviewUrl}
            preload="auto"
            loop
          />
        )}
        {voiceoverPreviewUrl !== "" && (
          <audio
            src={voiceoverPreviewUrl}
            preload="metadata"
            className="hidden"
            onLoadedMetadata={(event) =>
              setVoiceoverDuration(event.currentTarget.duration || 0)
            }
          />
        )}
      </motion.div>
    </div>
  );
}
