import { and, inArray, isNotNull } from "drizzle-orm";
import { Hono } from "hono";

import metadata from "../../../package.json" with { type: "json" };
import { db } from "../../db";
import { serializeAccountOwner } from "../../entities/account";
import { getInstanceHost } from "../../instance-host";
import { SUPPORTED_MEDIA_TYPES } from "../../media";
import { accountOwners, posts } from "../../schema";

const TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 10;
const cache = new Map<string, { body: unknown; expires: number }>();

function setCacheEntry(key: string, body: unknown): void {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expires <= now) cache.delete(k);
  }
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = [...cache.entries()].reduce((a, b) =>
      a[1].expires < b[1].expires ? a : b,
    );
    cache.delete(oldest[0]);
  }
  cache.set(key, { body, expires: now + TTL_MS });
}

const app = new Hono();

app.get("/", async (c) => {
  const url = new URL(c.req.url);
  const instanceHost = getInstanceHost(url);
  const cacheKey = url.origin;
  const cached = cache.get(cacheKey);
  if (cached != null && cached.expires > Date.now()) {
    return c.json(cached.body);
  }
  const credential = await db.query.credentials.findFirst();
  if (credential == null) return c.notFound();
  const accountOwner = await db.query.accountOwners.findFirst({
    with: { account: { with: { successor: true } } },
    orderBy: (accountOwners) => [accountOwners.id],
  });
  if (accountOwner == null) return c.notFound();
  const languages = await db
    .select({ language: posts.language })
    .from(posts)
    .where(
      and(
        isNotNull(posts.language),
        inArray(
          posts.accountId,
          db.select({ id: accountOwners.id }).from(accountOwners),
        ),
      ),
    )
    .groupBy(posts.language);
  const body = {
    api_versions: {
      mastodon: 7,
    },
    domain: instanceHost,
    title: instanceHost,
    version: metadata.version,
    source_url: "https://github.com/fedify-dev/hollo",
    description: `A Hollo instance at ${instanceHost}`,
    usage: {
      users: {
        // TODO: Track active users in the past 4 weeks
        active_month: 0,
      },
    },
    // TODO: Allow instance admins to customize the thumbnail image
    thumbnail: {
      url: `${url.origin}/public/favicon.png`,
      blurhash: null,
      versions: {},
    },
    // TODO: Allow instance admins to customize the icon
    icon: [
      {
        src: `${url.origin}/public/favicon.png`,
        size: "500x500",
      },
    ],
    languages: languages.map(({ language }) => language),
    configuration: {
      // TODO: urls (streaming_api)
      accounts: {
        // TODO: Make these configurable
        max_featured_tags: 10,
        max_pinned_statuses: 10,
      },
      statuses: {
        // TODO: Make these configurable
        max_characters: 10000,
        max_media_attachments: 8,
        characters_reserved_per_url: 256,
      },
      media_attachments: {
        supported_mime_types: SUPPORTED_MEDIA_TYPES,
        // TODO: Make these configurable
        image_size_limit: 1024 * 1024 * 32, // 32MiB
        image_matrix_limit: 16_777_216,
        // Mastodon has no separate audio limit; clients apply this to audio:
        video_size_limit: 1024 * 1024 * 128, // 128MiB
        video_frame_rate_limit: 120,
        video_matrix_limit: 16_777_216,
      },
      polls: {
        // TODO: Make these configurable
        max_options: 10,
        max_characters_per_option: 100,
        min_expiration: 60 * 5,
        max_expiration: 60 * 60 * 24 * 14,
      },
      translation: {
        enabled: false,
      },
      // TODO: Implement web push notifications and provide VAPID public key
      vapid: {
        public_key: "",
      },
    },
    registrations: {
      enabled: false,
      approval_required: true,
      message: null,
    },
    contact: {
      email: credential.email,
      account: serializeAccountOwner(accountOwner, c.req.url),
    },
    rules: [],
    feature_quote: true,
    fedibird_capabilities: [
      "emoji_reaction",
      "enable_wide_emoji",
      "enable_wide_emoji_reaction",
    ],
  };
  setCacheEntry(cacheKey, body);
  return c.json(body);
});

export default app;
