import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import mime from "mime";
import type { Metadata, Sharp } from "sharp";

import { db } from "../../db";
import { serializeMedium } from "../../entities/medium";
import {
  getDefaultScreenshot,
  getMediaExtension,
  makeVideoScreenshot,
  normalizeMediaType,
  uploadThumbnail,
} from "../../media";
import {
  scopeRequired,
  tokenRequired,
  withAccountOwner,
  type AccountOwnerVariables,
} from "../../oauth/middleware";
import { media } from "../../schema";
import { isUuid, uuidv7 } from "../../uuid";

const app = new Hono<{ Variables: AccountOwnerVariables }>();

export async function postMedia(
  c: Context<{ Variables: AccountOwnerVariables }>,
) {
  const [{ drive }, { default: sharp }] = await Promise.all([
    import("../../storage"),
    import("sharp"),
  ]);
  const disk = drive.use();
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "file is required" }, 422);
  }
  const description = form.get("description")?.toString();
  // Clients like curl send application/octet-stream (or nothing) unless told
  // otherwise, so fall back to guessing the type from the file name:
  const fileType = normalizeMediaType(
    file.type === "" || file.type === "application/octet-stream"
      ? (mime.getType(file.name) ?? file.type)
      : file.type,
  );
  const isVideo = fileType.startsWith("video/");
  const isAudio = fileType.startsWith("audio/");
  const id = uuidv7();
  const imageData = new Uint8Array(await file.arrayBuffer());
  let imageBytes: Uint8Array = imageData;
  if (isVideo) {
    imageBytes = await makeVideoScreenshot(imageData);
  } else if (isAudio) {
    // Audio files are stored as is; we don't extract cover art, but always
    // use the default screenshot as the thumbnail:
    imageBytes = getDefaultScreenshot();
  }

  let image: Sharp;
  let rmMetaImage: Buffer;
  let fileMetadata: Metadata;
  try {
    image = sharp(imageBytes).rotate();
    rmMetaImage = await image.keepIccProfile().toBuffer();
    fileMetadata = await sharp(rmMetaImage).metadata();
  } catch (_error) {
    return c.json({ error: "Unsupported or corrupted media file" }, 422);
  }
  const content =
    isVideo || isAudio
      ? new Uint8Array(imageData)
      : new Uint8Array(rmMetaImage);

  const extension = getMediaExtension(fileType);
  if (!extension) {
    return c.json({ error: "Unsupported media type" }, 400);
  }
  const sanitizedExt = extension.replace(/[/\\]/g, "");
  const path = `media/${id}/original.${sanitizedExt}`;
  try {
    await disk.put(path, content, {
      contentType: fileType,
      contentLength: content.byteLength,
      visibility: "public",
    });
  } catch (_error) {
    return c.json({ error: "Failed to save media file" }, 500);
  }
  const url = await disk.getUrl(path);
  const result = await db
    .insert(media)
    .values({
      id,
      type: fileType,
      url,
      width: fileMetadata.width!,
      height: fileMetadata.height!,
      description,
      ...(await uploadThumbnail(id, image)),
    })
    .returning();
  if (result.length < 1) {
    return c.json({ error: "Failed to insert media" }, 500);
  }
  return c.json(serializeMedium(result[0], c.req.url));
}

app.post(
  "/",
  tokenRequired,
  scopeRequired(["write:media"]),
  withAccountOwner,
  postMedia,
);

app.get("/:id", async (c) => {
  const mediumId = c.req.param("id");
  if (!isUuid(mediumId)) return c.json({ error: "Not found" }, 404);
  const medium = await db.query.media.findFirst({
    where: { id: { eq: mediumId } },
  });
  if (medium == null) return c.json({ error: "Not found" }, 404);
  return c.json(serializeMedium(medium, c.req.url));
});

app.put("/:id", tokenRequired, scopeRequired(["write:media"]), async (c) => {
  const mediumId = c.req.param("id");
  if (!isUuid(mediumId)) return c.json({ error: "Not found" }, 404);
  let description: string | undefined;
  try {
    const json = await c.req.json();
    description = json.description;
  } catch (_e) {
    const form = await c.req.formData();
    description = form.get("description")?.toString();
  }
  if (description == null) {
    return c.json({ error: "description is required" }, 422);
  }
  const result = await db
    .update(media)
    .set({ description })
    .where(eq(media.id, mediumId))
    .returning();
  if (result.length < 1) return c.json({ error: "Not found" }, 404);
  return c.json(serializeMedium(result[0], c.req.url));
});

export default app;
