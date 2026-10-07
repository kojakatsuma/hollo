import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import {
  bearerAuthorization,
  createAccount,
  createOAuthApplication,
  getAccessToken,
} from "../../tests/helpers/oauth";
import db from "../db";
import app from "../index";
import { accounts, instances, posts } from "../schema";
import { drive } from "../storage";
import type { Uuid } from "../uuid";
import { uuidv7 } from "../uuid";
import { parseViewingHours, type ViewingHours } from "../viewing-hours";

const config = vi.hoisted(() => ({
  hours: null as ViewingHours | null,
}));

vi.mock("../viewing-hours", async (importOriginal) => {
  const original = await importOriginal<typeof import("../viewing-hours")>();
  return {
    ...original,
    get VIEWING_HOURS() {
      return config.hours;
    },
  };
});

// 2026-10-08 10:00 in Asia/Tokyo, which is outside the viewing hours:
const OUTSIDE = new Date("2026-10-08T01:00:00Z");
// 2026-10-08 12:15 in Asia/Tokyo, which is inside the viewing hours:
const INSIDE = new Date("2026-10-08T03:15:00Z");

describe.sequential("viewing hours", () => {
  let owner: Awaited<ReturnType<typeof createAccount>>;
  let authorization: string;
  let remotePostId: Uuid;
  let ownPostId: Uuid;

  beforeEach(async () => {
    await cleanDatabase();
    config.hours = parseViewingHours("07:00-08:00,12:00-12:30", "Asia/Tokyo");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(INSIDE);

    owner = await createAccount({ generateKeyPair: true });
    const client = await createOAuthApplication({ scopes: ["read", "write"] });
    const accessToken = await getAccessToken(client, owner, ["read", "write"]);
    authorization = bearerAuthorization(accessToken);

    await db
      .insert(instances)
      .values({ host: "remote.test" })
      .onConflictDoNothing();
    const authorId = crypto.randomUUID() as Uuid;
    await db.insert(accounts).values({
      id: authorId,
      iri: "https://remote.test/users/author",
      instanceHost: "remote.test",
      type: "Person",
      name: "Remote author",
      emojis: {},
      handle: "@author@remote.test",
      bioHtml: "",
      url: "https://remote.test/@author",
      protected: false,
      inboxUrl: "https://remote.test/users/author/inbox",
    });
    remotePostId = uuidv7();
    ownPostId = uuidv7();
    await db.insert(posts).values([
      {
        id: remotePostId,
        iri: `https://remote.test/notes/${remotePostId}`,
        type: "Note",
        accountId: authorId,
        visibility: "public",
        content: "Remote post",
        contentHtml: "<p>Remote post</p>",
        published: new Date(),
      },
      {
        id: ownPostId,
        iri: `https://hollo.test/@hollo/${ownPostId}`,
        type: "Note",
        accountId: owner.id,
        visibility: "public",
        content: "Own post",
        contentHtml: "<p>Own post</p>",
        published: new Date(),
      },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
    config.hours = null;
  });

  function get(path: string) {
    return app.request(path, { method: "GET", headers: { authorization } });
  }

  describe("outside the viewing hours", () => {
    beforeEach(() => {
      vi.setSystemTime(OUTSIDE);
    });

    it.each([
      ["/api/v1/timelines/home", []],
      ["/api/v1/timelines/public", []],
      ["/api/v1/timelines/tag/hollo", []],
      [`/api/v1/timelines/list/${crypto.randomUUID()}`, []],
      ["/api/v1/notifications", []],
      [
        "/api/v2/notifications",
        { accounts: [], statuses: [], notification_groups: [] },
      ],
      ["/api/v2/notifications/unread_count", { count: 0 }],
      ["/api/v2/notifications/some-group/accounts", []],
      ["/api/v2/search?q=remote", { accounts: [], statuses: [], hashtags: [] }],
      ["/api/v1/favourites", []],
      ["/api/v1/bookmarks", []],
    ])("returns an empty result for %s", async (path, expected) => {
      expect.assertions(4);
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
      expect(response.headers.get("X-Viewing-Hours-Next")).toBe(
        "2026-10-08T12:00:00+09:00",
      );
      expect(response.headers.get("Link")).toBeNull();
    });

    it("returns an empty result for others' account statuses", async () => {
      expect.assertions(2);
      const remote = await db.query.posts.findFirst({
        where: { id: { eq: remotePostId } },
      });
      const response = await get(
        `/api/v1/accounts/${remote!.accountId}/statuses`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    });

    it("returns an empty context and reaction lists", async () => {
      expect.assertions(6);
      for (const id of [remotePostId, ownPostId]) {
        const context = await get(`/api/v1/statuses/${id}/context`);
        expect(await context.json()).toEqual({
          ancestors: [],
          descendants: [],
        });
        const favouritedBy = await get(`/api/v1/statuses/${id}/favourited_by`);
        expect(await favouritedBy.json()).toEqual([]);
        const rebloggedBy = await get(`/api/v1/statuses/${id}/reblogged_by`);
        expect(await rebloggedBy.json()).toEqual([]);
      }
    });

    it("forbids reading others' posts", async () => {
      expect.assertions(4);
      const response = await get(`/api/v1/statuses/${remotePostId}`);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "閲覧できる時間外です。次は 12:00 から閲覧できます。",
      });
      expect(response.headers.get("X-Viewing-Hours-Next")).toBe(
        "2026-10-08T12:00:00+09:00",
      );
      const notification = await get("/api/v2/notifications/some-group");
      expect(notification.status).toBe(403);
    });

    it("forbids reading the owner's boost of others' posts", async () => {
      expect.assertions(1);
      const boostId = uuidv7();
      await db.insert(posts).values({
        id: boostId,
        iri: `https://hollo.test/@hollo/${boostId}`,
        type: "Note",
        accountId: owner.id,
        sharingId: remotePostId,
        visibility: "public",
        published: new Date(),
      });
      const response = await get(`/api/v1/statuses/${boostId}`);
      expect(response.status).toBe(403);
    });

    it("allows reading the owner's posts and account statuses", async () => {
      expect.assertions(5);
      const post = await get(`/api/v1/statuses/${ownPostId}`);
      expect(post.status).toBe(200);
      expect((await post.json()).id).toBe(ownPostId);
      const statuses = await get(`/api/v1/accounts/${owner.id}/statuses`);
      expect(statuses.status).toBe(200);
      const json = await statuses.json();
      expect(json).toHaveLength(1);
      expect(json[0].id).toBe(ownPostId);
    });

    it("allows posting statuses", async () => {
      expect.assertions(2);
      const response = await app.request("/api/v1/statuses", {
        method: "POST",
        headers: { authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "Posted outside viewing hours" }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).content).toContain(
        "Posted outside viewing hours",
      );
    });

    it("allows uploading media", async () => {
      expect.assertions(2);
      drive.fake();
      try {
        const image = await readFile(
          join(
            import.meta.dirname,
            "..",
            "..",
            "assets",
            "default-screenshot.png",
          ),
        );
        const body = new FormData();
        body.append(
          "file",
          new File([image], "image.png", { type: "image/png" }),
        );
        const response = await app.request("/api/v2/media", {
          method: "POST",
          headers: { authorization },
          body,
        });
        expect(response.status).toBe(200);
        expect((await response.json()).type).toBe("image");
      } finally {
        drive.restore();
      }
    });

    it("allows endpoints that clients use to start up", async () => {
      expect.assertions(4);
      for (const path of [
        "/api/v1/accounts/verify_credentials",
        "/api/v1/preferences",
        "/api/v2/instance",
        "/api/v1/markers?timeline[]=home",
      ]) {
        const response = await get(path);
        expect(response.status).toBe(200);
      }
    });
  });

  describe("inside the viewing hours", () => {
    it("serves others' posts and timelines as usual", async () => {
      expect.assertions(5);
      const post = await get(`/api/v1/statuses/${remotePostId}`);
      expect(post.status).toBe(200);
      expect(post.headers.get("X-Viewing-Hours-Next")).toBeNull();
      expect((await post.json()).id).toBe(remotePostId);
      const timeline = await get("/api/v1/timelines/public");
      expect(timeline.status).toBe(200);
      expect(
        (await timeline.json()).map((s: { id: string }) => s.id),
      ).toContain(remotePostId);
    });

    it("treats the end of a range as outside", async () => {
      expect.assertions(2);
      // 12:30 in Asia/Tokyo:
      vi.setSystemTime(new Date("2026-10-08T03:30:00Z"));
      const response = await get(`/api/v1/statuses/${remotePostId}`);
      expect(response.status).toBe(403);
      expect(response.headers.get("X-Viewing-Hours-Next")).toBe(
        "2026-10-09T07:00:00+09:00",
      );
    });
  });

  describe("with VIEWING_HOURS=off", () => {
    it("does not restrict anything", async () => {
      expect.assertions(4);
      config.hours = parseViewingHours("off");
      vi.setSystemTime(OUTSIDE);
      const post = await get(`/api/v1/statuses/${remotePostId}`);
      expect(post.status).toBe(200);
      expect(post.headers.get("X-Viewing-Hours-Next")).toBeNull();
      const timeline = await get("/api/v1/timelines/public");
      expect(timeline.status).toBe(200);
      expect(
        (await timeline.json()).map((s: { id: string }) => s.id),
      ).toContain(remotePostId);
    });
  });
});
