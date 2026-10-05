import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getLogger } from "@logtape/logtape";
import mime from "mime";
import type { Sharp } from "sharp";

const logger = getLogger(["hollo", "media"]);
const DEFAULT_THUMBNAIL_AREA = 230_400;
const defaultScreenshot = readFileSync(
  join(import.meta.dirname, "..", "assets", "default-screenshot.png"),
);

/**
 * The default screenshot image, used as the thumbnail for media that have
 * no visual frame of their own (audio) or whose frame could not be extracted.
 */
export function getDefaultScreenshot(): Uint8Array {
  return defaultScreenshot;
}

/**
 * MIME types accepted for media uploads, as advertised by the instance API.
 */
export const SUPPORTED_MEDIA_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/ogg",
  "audio/vorbis",
  "audio/opus",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/flac",
  "audio/x-flac",
  "audio/webm",
];

const AUDIO_MIME_TYPE_ALIASES: Record<string, string> = {
  "audio/mp3": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-mp3": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/x-mpeg-3": "audio/mpeg",
  "audio/mpg": "audio/mpeg",
  "audio/m4a": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "audio/wave": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-pn-wav": "audio/wav",
  "audio/x-flac": "audio/flac",
  "audio/x-aac": "audio/aac",
  "audio/vorbis": "audio/ogg",
  "audio/opus": "audio/ogg",
};

const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/flac": "flac",
  "audio/webm": "webm",
};

/**
 * Normalizes a media MIME type: strips parameters, lowercases it, and maps
 * non-standard audio aliases that browsers send (e.g., `audio/mp3`) to their
 * canonical forms (e.g., `audio/mpeg`).
 */
export function normalizeMediaType(type: string): string {
  const base = type.split(";")[0].trim().toLowerCase();
  return AUDIO_MIME_TYPE_ALIASES[base] ?? base;
}

/**
 * Gets the file extension for a (normalized) media MIME type.  Unlike
 * `mime.getExtension()`, this returns `mp3` rather than `mpga` for
 * `audio/mpeg`, and covers `audio/flac`.
 */
export function getMediaExtension(type: string): string | null {
  return AUDIO_EXTENSIONS[type] ?? mime.getExtension(type);
}

export interface Thumbnail {
  thumbnailUrl: string;
  thumbnailType: string;
  thumbnailWidth: number;
  thumbnailHeight: number;
}

export async function uploadThumbnail(
  id: string,
  original: Sharp,
  thumbnailArea = DEFAULT_THUMBNAIL_AREA,
): Promise<Thumbnail> {
  const { drive } = await import("./storage");
  const disk = drive.use();
  const originalMetadata = await original.metadata();
  let width = originalMetadata.width!;
  let height = originalMetadata.height!;
  if (
    originalMetadata.orientation != null &&
    originalMetadata.orientation !== 1
  ) {
    original = original.clone();
    original.rotate();
    if (originalMetadata.orientation !== 3) {
      [width, height] = [height, width];
    }
  }
  const thumbnailSize = calculateThumbnailSize(width, height, thumbnailArea);
  const thumbnail = await original
    .resize(thumbnailSize)
    .webp({ nearLossless: true })
    .toBuffer();
  const content = new Uint8Array(thumbnail);
  try {
    await disk.put(`media/${id}/thumbnail.webp`, content, {
      contentType: "image/webp",
      contentLength: content.byteLength,
      visibility: "public",
    });
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new Error(`Failed to store thumbnail: ${error.message}`, error);
    }
    throw error;
  }
  return {
    thumbnailUrl: await disk.getUrl(`media/${id}/thumbnail.webp`),
    thumbnailType: "image/webp",
    thumbnailWidth: thumbnailSize.width,
    thumbnailHeight: thumbnailSize.height,
  };
}

export function calculateThumbnailSize(
  width: number,
  height: number,
  maxArea: number,
): { width: number; height: number } {
  const ratio = width / height;
  if (width * height <= maxArea) return { width, height };
  const newHeight = Math.sqrt(maxArea / ratio);
  const newWidth = ratio * newHeight;
  return { width: Math.round(newWidth), height: Math.round(newHeight) };
}

export async function makeVideoScreenshot(
  videoData: Uint8Array,
): Promise<Uint8Array> {
  let tmpDir: string | undefined;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "hollo-"));
    const inFile = join(tmpDir, "video");
    await writeFile(inFile, videoData);
    const resultBuffer: Buffer = await new Promise((resolve) => {
      const process = spawn("ffmpeg", [
        "-i",
        inFile,
        "-vframes",
        "1",
        "-f",
        "image2pipe",
        "pipe:1",
      ]);
      const stdout = process.stdout;
      const stderr = process.stderr;
      const chunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      if (!stdout || !stderr) {
        logger.error(
          "Could not build pipes to ffmpeg, can't create a video screenshot",
        );
        resolve(defaultScreenshot);
        return;
      }
      stdout.on("data", (chunk) => {
        chunks.push(chunk);
      });
      stderr.on("data", (chunk) => {
        stderrChunks.push(chunk);
      });
      process.on("close", (code) => {
        if (code !== 0) {
          logger.error("ffmpeg returned a bad error code {code}", { code });
          logger.error("ffmpeg output: {stderr}", {
            stderr: Buffer.concat(stderrChunks).toString(),
          });
          resolve(defaultScreenshot);
          return;
        }
        resolve(Buffer.concat(chunks));
      });
      process.on("error", (error) => {
        logger.error("Could not run ffmpeg: {error}", { error });
        logger.error("ffmpeg output: {stderr}", {
          stderr: Buffer.concat(stderrChunks).toString(),
        });
        resolve(defaultScreenshot);
      });
    });
    return resultBuffer;
  } catch (error) {
    logger.error("Could not prepare temporary file for ffmpeg: {error}", {
      error,
    });
    return defaultScreenshot;
  } finally {
    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch (cleanupError) {
        logger.warn("Failed to clean up temporary directory: {error}", {
          error: cleanupError,
        });
      }
    }
  }
}
