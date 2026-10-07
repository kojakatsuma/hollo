import { zValidator } from "@hono/zod-validator";
import { Temporal } from "@js-temporal/polyfill";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../../db";
import { serializeAccount } from "../../entities/account";
import { getPostRelations, serializePost } from "../../entities/status";
import { serializeTag } from "../../entities/tag";
import { proxyUrl } from "../../media-proxy";
import {
  scopeRequired,
  tokenRequired,
  withAccountOwner,
  type AccountOwnerVariables,
} from "../../oauth/middleware";
import { uuid } from "../../uuid";
import {
  emptyOutsideViewingHours,
  forbiddenOutsideViewingHours,
  isOwnAccount,
  isOwnPoll,
  isOwnPost,
} from "../viewing-hours";
import accounts from "./accounts";
import apps from "./apps";
import featured_tags from "./featured_tags";
import follow_requests from "./follow_requests";
import instance from "./instance";
import lists from "./lists";
import markers from "./markers";
import media from "./media";
import notifications from "./notifications";
import polls from "./polls";
import reports from "./reports";
import statuses from "./statuses";
import tags from "./tags";
import timelines from "./timelines";

const app = new Hono<{ Variables: AccountOwnerVariables }>();

// Endpoints that read others' posts and notifications are closed outside
// the viewing hours (VIEWING_HOURS).  These guards have to be registered
// before the routes they protect:
app.get("/timelines/*", emptyOutsideViewingHours([]));
app.get("/notifications", emptyOutsideViewingHours([]));
app.get("/favourites", emptyOutsideViewingHours([]));
app.get("/bookmarks", emptyOutsideViewingHours([]));
app.get(
  "/accounts/:id/statuses",
  emptyOutsideViewingHours([], { exemptIf: isOwnAccount }),
);
app.get("/statuses/:id", forbiddenOutsideViewingHours({ exemptIf: isOwnPost }));
app.get(
  "/statuses/:id/source",
  forbiddenOutsideViewingHours({ exemptIf: isOwnPost }),
);
app.get(
  "/statuses/:id/context",
  emptyOutsideViewingHours({ ancestors: [], descendants: [] }),
);
app.get("/statuses/:id/favourited_by", emptyOutsideViewingHours([]));
app.get("/statuses/:id/reblogged_by", emptyOutsideViewingHours([]));
app.get("/statuses/:id/quotes", emptyOutsideViewingHours([]));
app.get("/polls/:id", forbiddenOutsideViewingHours({ exemptIf: isOwnPoll }));

app.route("/apps", apps);
app.route("/accounts", accounts);
app.route("/featured_tags", featured_tags);
app.route("/follow_requests", follow_requests);
app.route("/instance", instance);
app.route("/lists", lists);
app.route("/markers", markers);
app.route("/media", media);
app.route("/notifications", notifications);
app.route("/polls", polls);
app.route("/statuses", statuses);
app.route("/tags", tags);
app.route("/timelines", timelines);
app.route("/reports", reports);

app.get(
  "/preferences",
  tokenRequired,
  scopeRequired(["read:accounts"]),
  withAccountOwner,
  (c) => {
    const owner = c.get("accountOwner");
    return c.json({
      "posting:default:visibility": owner.visibility,
      "posting:default:sensitive": owner.account.sensitive,
      "posting:default:language": owner.language,
      "reading:expand:media": "default",
      "reading:expand:spoilers": owner.expandSpoilers,
    });
  },
);

app.get("/custom_emojis", async (c) => {
  const emojis = await db.query.customEmojis.findMany();
  const baseUrl = c.req.url;
  return c.json(
    emojis.flatMap((emoji) => {
      const url = proxyUrl(emoji.url, baseUrl);
      if (url == null) return [];
      return [
        {
          shortcode: emoji.shortcode,
          url,
          static_url: url,
          visible_in_picker: true,
          category: emoji.category,
        },
      ];
    }),
  );
});

app.get("/announcements", (c) => {
  return c.json([]);
});

app.get("/trends/tags", (c) => {
  return c.json([]);
});

app.get("/trends/statuses", (c) => {
  return c.json([]);
});

app.get("/trends/links", (c) => {
  return c.json([]);
});

// Mastodon clients also request /trends without a subpath,
// which is equivalent to /trends/tags:
app.get("/trends", (c) => {
  return c.json([]);
});

app.get(
  "/suggestions",
  tokenRequired,
  scopeRequired(["read:accounts"]),
  (c) => {
    return c.json([]);
  },
);

app.get(
  "/favourites",
  tokenRequired,
  scopeRequired(["read:favourites"]),
  withAccountOwner,
  zValidator(
    "query",
    z.object({
      before: z.iso.datetime().optional(),
      limit: z
        .string()
        .default("20")
        .transform((v) => Number.parseInt(v, 10)),
    }),
  ),
  async (c) => {
    const owner = c.get("accountOwner");
    const query = c.req.valid("query");
    const favourites = await db.query.likes.findMany({
      where: {
        RAW: (likes, { and, eq, lt }) =>
          and(
            eq(likes.accountId, owner.id),
            query.before == null
              ? undefined
              : lt(likes.created, new Date(query.before)),
          )!,
      },
      with: {
        post: { with: getPostRelations(owner.id) },
      },
      orderBy: (likes, { desc }) => [desc(likes.created)],
      limit: query.limit,
    });
    return c.json(
      favourites.map((like) => serializePost(like.post, owner, c.req.url)),
      200,
      favourites.length < query.limit
        ? {}
        : {
            Link: `<${
              new URL(
                `?before=${encodeURIComponent(
                  favourites[favourites.length - 1].created.toISOString(),
                )}&limit=${query.limit}`,
                c.req.url,
              ).href
            }>; rel="next"`,
          },
    );
  },
);

app.get(
  "/bookmarks",
  tokenRequired,
  scopeRequired(["read:bookmarks"]),
  withAccountOwner,
  zValidator(
    "query",
    z.object({
      before: z.iso.datetime().optional(),
      limit: z
        .string()
        .default("20")
        .transform((v) => Number.parseInt(v, 10)),
    }),
  ),
  async (c) => {
    const owner = c.get("accountOwner");
    const query = c.req.valid("query");
    const bookmarkList = await db.query.bookmarks.findMany({
      where: {
        RAW: (bookmarks, { and, eq, lt }) =>
          and(
            eq(bookmarks.accountOwnerId, owner.id),
            query.before == null
              ? undefined
              : lt(bookmarks.created, new Date(query.before)),
          )!,
      },
      with: {
        post: { with: getPostRelations(owner.id) },
      },
      orderBy: (bookmarks, { desc }) => [desc(bookmarks.created)],
      limit: query.limit,
    });
    return c.json(
      bookmarkList.map((bm) => serializePost(bm.post, owner, c.req.url)),
      200,
      bookmarkList.length < query.limit
        ? {}
        : {
            Link: `<${
              new URL(
                `?before=${encodeURIComponent(
                  bookmarkList[bookmarkList.length - 1].created.toISOString(),
                )}&limit=${query.limit}`,
                c.req.url,
              ).href
            }>; rel="next"`,
          },
    );
  },
);

app.get(
  "/followed_tags",
  tokenRequired,
  scopeRequired(["read:follows"]),
  withAccountOwner,
  (c) => {
    const owner = c.get("accountOwner");
    return c.json(
      owner.followedTags.map((tag) => serializeTag(tag, owner, c.req.url)),
    );
  },
);

app.get(
  "/mutes",
  tokenRequired,
  scopeRequired(["read:mutes"]),
  withAccountOwner,
  zValidator(
    "query",
    z.object({
      max_id: uuid.optional(),
      since_id: uuid.optional(),
      limit: z
        .string()
        .default("40")
        .transform((v) => {
          const parsed = Number.parseInt(v, 10);
          return Math.min(parsed, 80);
        }),
    }),
  ),
  async (c) => {
    const owner = c.get("accountOwner");

    const muteList = await db.query.mutes.findMany({
      where: { accountId: { eq: owner.id } },
    });

    if (muteList.length < 1) return c.json([]);

    const query = c.req.valid("query");

    const mutedAccounts = await db.query.accounts.findMany({
      where: {
        RAW: (accountsTable, { and, gte, inArray, lte }) =>
          and(
            inArray(
              accountsTable.id,
              muteList.map((m) => m.mutedAccountId),
            ),
            query.max_id == null
              ? undefined
              : lte(accountsTable.id, query.max_id),
            query.since_id == null
              ? undefined
              : gte(accountsTable.id, query.since_id),
          )!,
      },
      with: { owner: true, successor: true },
      orderBy: (accountsTable, { desc }) => [desc(accountsTable.id)],
      limit: query.limit ?? 40,
    });

    return c.json(mutedAccounts.map((a) => serializeAccount(a, c.req.url)));
  },
);

app.get(
  "/blocks",
  tokenRequired,
  scopeRequired(["read:blocks"]),
  withAccountOwner,
  zValidator(
    "query",
    z.object({
      until: z.iso.datetime().optional(),
      limit: z
        .string()
        .default("40")
        .transform((v) => {
          const parsed = Number.parseInt(v, 10);
          return Math.min(parsed, 80);
        }),
    }),
  ),
  async (c) => {
    const owner = c.get("accountOwner");

    const query = c.req.valid("query");
    const blockList = await db.query.blocks.findMany({
      where: {
        RAW: (blocks, { and, eq, lte }) =>
          and(
            eq(blocks.accountId, owner.id),
            query.until == null ? undefined : lte(blocks.created, query.until),
          )!,
      },
      orderBy: (blocks, { desc }) => [desc(blocks.created)],
      limit: query.limit + 1,
      with: {
        blockedAccount: { with: { owner: true, successor: true } },
      },
    });

    let next: URL | null = null;
    if (blockList.length > query.limit) {
      next = new URL(c.req.url);
      next.searchParams.set(
        "until",
        Temporal.Instant.from(blockList[query.limit].created).toString(),
      );
    }

    return c.json(
      blockList
        .slice(0, query.limit)
        .map((b) => serializeAccount(b.blockedAccount, c.req.url)),
      {
        headers: next == null ? {} : { Link: `<${next.href}>; rel="next"` },
      },
    );
  },
);

export default app;
