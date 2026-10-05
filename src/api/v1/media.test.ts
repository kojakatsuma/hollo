import { readFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../../tests/helpers";
import {
  bearerAuthorization,
  createAccount,
  createOAuthApplication,
  getAccessToken,
} from "../../../tests/helpers/oauth";
import db from "../../db";
import app from "../../index";
import { credentials } from "../../schema";
import { drive } from "../../storage";

// A stand-in for an MP3 file; the audio stream is never decoded on upload:
const audioBytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]);

const defaultScreenshotMetadata = await sharp(
  await readFile(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "assets",
      "default-screenshot.png",
    ),
  ),
).metadata();

describe.sequential("POST /api/v1/media with audio", () => {
  let accessToken: Awaited<ReturnType<typeof getAccessToken>>;

  beforeEach(async () => {
    await cleanDatabase();
    drive.fake();

    const account = await createAccount();
    const client = await createOAuthApplication({ scopes: ["write"] });
    accessToken = await getAccessToken(client, account, ["write"]);
  });

  afterEach(() => {
    drive.restore();
  });

  async function upload(endpoint: string, file: File) {
    const body = new FormData();
    body.append("file", file);
    body.append("description", "A song");
    return await app.request(endpoint, {
      method: "POST",
      headers: { authorization: bearerAuthorization(accessToken) },
      body,
    });
  }

  it.each([
    ["/api/v1/media", "audio/mpeg"],
    ["/api/v2/media", "audio/mpeg"],
    ["/api/v1/media", "audio/mp3"],
  ])("stores %s uploads of %s as is", async (endpoint, type) => {
    expect.assertions(9);

    const response = await upload(
      endpoint,
      new File([audioBytes], "song.mp3", { type }),
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.type).toBe("audio");
    expect(json.url).toMatch(/\/original\.mp3$/);
    expect(json.preview_url).toMatch(/\/thumbnail\.webp$/);
    expect(json.description).toBe("A song");

    const medium = await db.query.media.findFirst({
      where: { id: { eq: json.id } },
    });
    expect(medium?.type).toBe("audio/mpeg");
    expect(medium?.width).toBe(defaultScreenshotMetadata.width);
    expect(medium?.height).toBe(defaultScreenshotMetadata.height);

    const stored = await readStoredFile(`media/${json.id}/original.mp3`);
    expect(stored).toEqual(audioBytes);
  });

  it("infers the audio type from the file name for octet-stream", async () => {
    expect.assertions(3);

    const response = await upload(
      "/api/v1/media",
      new File([audioBytes], "song.mp3", {
        type: "application/octet-stream",
      }),
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.type).toBe("audio");
    expect(json.url).toMatch(/\/original\.mp3$/);
  });

  it.each([
    ["audio/ogg", "ogg"],
    ["audio/x-wav", "wav"],
    ["audio/flac", "flac"],
    ["audio/x-m4a", "m4a"],
  ])("uses a sensible extension for %s", async (type, extension) => {
    expect.assertions(3);

    const response = await upload(
      "/api/v1/media",
      new File([audioBytes], `audio.${extension}`, { type }),
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.type).toBe("audio");
    expect(json.url).toMatch(new RegExp(`/original\\.${extension}$`));
  });
});

describe.each(["/api/v1/instance", "/api/v2/instance"])("GET %s", (path) => {
  beforeEach(async () => {
    await cleanDatabase();
    await db
      .insert(credentials)
      .values({ email: "hollo@hollo.test", passwordHash: "unused" });
    await createAccount();
  });

  it("advertises audio MIME types", async () => {
    expect.assertions(2);

    const response = await app.request(path);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.configuration.media_attachments.supported_mime_types).toEqual(
      expect.arrayContaining([
        "audio/mpeg",
        "audio/mp4",
        "audio/ogg",
        "audio/wav",
        "audio/flac",
        "audio/webm",
      ]),
    );
  });
});

async function readStoredFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await drive.use().getBytes(path));
}
