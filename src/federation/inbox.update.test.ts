import type { InboxContext } from "@fedify/fedify";
import { Delete, Note, Person, PUBLIC_COLLECTION, Update } from "@fedify/vocab";
import { beforeEach, describe, expect, it } from "vitest";

import { cleanDatabase } from "../../tests/helpers";
import db from "../db";
import { accounts, instances, posts } from "../schema";
import type { Uuid } from "../uuid";
import { toTemporalInstant } from "./date";
import { onPostDeleted, onPostUpdated } from "./inbox";

const ctx = {
  origin: "https://hollo.test",
} as InboxContext<void>;

async function seedRemoteAccount(host: string, username: string) {
  const id = crypto.randomUUID() as Uuid;
  const iri = `https://${host}/@${username}`;
  await db
    .insert(instances)
    .values({ host, software: "mastodon", softwareVersion: null })
    .onConflictDoNothing();
  await db.insert(accounts).values({
    id,
    iri,
    type: "Person",
    name: username,
    handle: `@${username}@${host}`,
    bioHtml: "",
    emojis: {},
    fieldHtmls: {},
    aliases: [],
    protected: false,
    inboxUrl: `${iri}/inbox`,
    followersUrl: `${iri}/followers`,
    sharedInboxUrl: `https://${host}/inbox`,
    featuredUrl: `${iri}/featured`,
    instanceHost: host,
    published: new Date(),
  });
  const account = await db.query.accounts.findFirst({
    where: { id: { eq: id } },
  });
  if (account == null) throw new Error("Failed to seed remote account");
  return account;
}

async function seedRemotePost(
  authorId: Uuid,
  authorIri: string,
  initialContent: string,
) {
  const id = crypto.randomUUID() as Uuid;
  const iri = `${authorIri}/posts/${id}`;
  await db.insert(posts).values({
    id,
    iri,
    type: "Note",
    accountId: authorId,
    visibility: "public",
    contentHtml: `<p>${initialContent}</p>`,
    content: initialContent,
    tags: {},
    emojis: {},
    sensitive: false,
    published: new Date(),
    updated: new Date(),
  });
  return { id, iri };
}

describe("onPostUpdated", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("ignores Update from an actor on a different origin than the post", async () => {
    expect.assertions(2);
    const author = await seedRemoteAccount("remote.test", "author");
    const evil = await seedRemoteAccount("evil.test", "evil");
    const post = await seedRemotePost(author.id, author.iri, "original");

    const update = new Update({
      id: new URL(`${evil.iri}#update/${post.id}`),
      actor: new URL(evil.iri),
      object: new Note({
        id: new URL(post.iri),
        attribution: new Person({ id: new URL(author.iri) }),
        content: "hijacked",
        to: PUBLIC_COLLECTION,
      }),
    });

    await onPostUpdated(ctx, update);

    const after = await db.query.posts.findFirst({
      where: { iri: { eq: post.iri } },
    });
    expect(after?.content).toBe("original");
    expect(after?.contentHtml).toBe("<p>original</p>");
  });

  it("does not first-materialize a forged post whose id is on another origin", async () => {
    expect.assertions(1);
    const evil = await seedRemoteAccount("evil.test", "evil");
    const forgedIri = "https://remote.test/@author/posts/forged";

    const update = new Update({
      id: new URL(`${evil.iri}#update/forge`),
      actor: new URL(evil.iri),
      object: new Note({
        id: new URL(forgedIri),
        attribution: new Person({
          id: new URL("https://remote.test/@author"),
        }),
        content: "forged",
        to: PUBLIC_COLLECTION,
      }),
    });

    await onPostUpdated(ctx, update);

    const after = await db.query.posts.findFirst({
      where: { iri: { eq: forgedIri } },
    });
    expect(after).toBeUndefined();
  });

  it("does not first-materialize a post whose attribution origin differs from its id", async () => {
    expect.assertions(1);
    const evil = await seedRemoteAccount("evil.test", "evil");
    // Object id is on evil.test (matches Update actor), but attribution
    // claims a remote.test actor. The check must still refuse.
    const forgedIri = `${evil.iri}/posts/masquerade`;

    const update = new Update({
      id: new URL(`${evil.iri}#update/masquerade`),
      actor: new URL(evil.iri),
      object: new Note({
        id: new URL(forgedIri),
        attribution: new Person({
          id: new URL("https://remote.test/@author"),
        }),
        content: "masquerade",
        to: PUBLIC_COLLECTION,
      }),
    });

    await onPostUpdated(ctx, update);

    const after = await db.query.posts.findFirst({
      where: { iri: { eq: forgedIri } },
    });
    expect(after).toBeUndefined();
  });

  it("stores an edit as a reply instead of overwriting the original", async () => {
    expect.assertions(6);
    const author = await seedRemoteAccount("remote.test", "author");
    const post = await seedRemotePost(author.id, author.iri, "original");
    const editedAt = toTemporalInstant(new Date("2026-01-01T00:00:00Z"));

    const update = new Update({
      id: new URL(`${post.iri}#updates/1`),
      actor: new URL(author.iri),
      object: new Note({
        id: new URL(post.iri),
        attribution: new Person({
          id: new URL(author.iri),
          preferredUsername: "author",
          inbox: new URL(`${author.iri}/inbox`),
        }),
        content: "edited",
        to: PUBLIC_COLLECTION,
        updated: editedAt,
      }),
    });

    await onPostUpdated(ctx, update);
    // Redelivery of the same edit must not create a duplicate:
    await onPostUpdated(ctx, update);

    const original = await db.query.posts.findFirst({
      where: { iri: { eq: post.iri } },
    });
    expect(original?.contentHtml).toBe("<p>original</p>");

    const edits = await db.query.posts.findMany({
      where: { replyTargetId: { eq: post.id } },
    });
    expect(edits).toHaveLength(1);
    expect(edits[0].iri).toBe(
      `${post.iri}#hollo-edit-${editedAt.epochMilliseconds}`,
    );
    expect(edits[0].contentHtml).toBe("edited");
    expect(edits[0].accountId).toBe(author.id);
    expect(edits[0].visibility).toBe("public");
  });

  it("deletes stored edits together with the original post", async () => {
    expect.assertions(2);
    const author = await seedRemoteAccount("remote.test", "author");
    const post = await seedRemotePost(author.id, author.iri, "original");

    await onPostUpdated(
      ctx,
      new Update({
        id: new URL(`${post.iri}#updates/1`),
        actor: new URL(author.iri),
        object: new Note({
          id: new URL(post.iri),
          attribution: new Person({
            id: new URL(author.iri),
            preferredUsername: "author",
            inbox: new URL(`${author.iri}/inbox`),
          }),
          content: "edited",
          to: PUBLIC_COLLECTION,
          updated: toTemporalInstant(new Date("2026-01-01T00:00:00Z")),
        }),
      }),
    );
    expect(
      await db.query.posts.findMany({
        where: { replyTargetId: { eq: post.id } },
      }),
    ).toHaveLength(1);

    await onPostDeleted(
      ctx,
      new Delete({
        id: new URL(`${post.iri}#delete`),
        actor: new URL(author.iri),
        object: new URL(post.iri),
      }),
    );

    expect(
      await db.query.posts.findMany({
        where: { accountId: { eq: author.id } },
      }),
    ).toHaveLength(0);
  });
});
