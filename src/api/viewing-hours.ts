import { Temporal } from "@js-temporal/polyfill";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import { db } from "../db";
import { isUuid, type Uuid } from "../uuid";
import {
  getNextViewingStart,
  isViewingAllowed,
  VIEWING_HOURS,
} from "../viewing-hours";

export const VIEWING_HOURS_NEXT_HEADER = "X-Viewing-Hours-Next";

/**
 * Decides whether a request may bypass the viewing hours, e.g., because it
 * reads the owner's own content.
 */
export type ViewingHoursExemption = (c: Context) => Promise<boolean>;

export interface ViewingHoursGuardOptions {
  readonly exemptIf?: ViewingHoursExemption;
}

/**
 * Returns when viewing becomes allowed next, or `null` if it is allowed now.
 */
function getNextViewingTime(): Temporal.ZonedDateTime | null {
  if (VIEWING_HOURS == null) return null;
  const now = Temporal.Instant.fromEpochMilliseconds(Date.now());
  if (isViewingAllowed(VIEWING_HOURS, now)) return null;
  return getNextViewingStart(VIEWING_HOURS, now);
}

function guard(
  respond: (c: Context, next: Temporal.ZonedDateTime) => Response,
  options: ViewingHoursGuardOptions,
) {
  return createMiddleware(async (c, next) => {
    const nextTime = getNextViewingTime();
    if (nextTime == null || (await options.exemptIf?.(c))) {
      await next();
      return;
    }
    c.header(
      VIEWING_HOURS_NEXT_HEADER,
      nextTime.toString({ timeZoneName: "never" }),
    );
    return respond(c, nextTime);
  });
}

/**
 * Outside the viewing hours, responds with the given empty result instead of
 * the actual list.  No `Link` header is sent, so clients do not paginate.
 */
export function emptyOutsideViewingHours(
  emptyBody: unknown,
  options: ViewingHoursGuardOptions = {},
) {
  const body = JSON.stringify(emptyBody);
  return guard(
    (c) => c.body(body, 200, { "Content-Type": "application/json" }),
    options,
  );
}

/**
 * Outside the viewing hours, responds with 403 Forbidden.
 */
export function forbiddenOutsideViewingHours(
  options: ViewingHoursGuardOptions = {},
) {
  return guard((c, nextTime) => {
    const time = nextTime.toPlainTime().toString({ smallestUnit: "minute" });
    return c.json(
      { error: `閲覧できる時間外です。次は ${time} から閲覧できます。` },
      403,
    );
  }, options);
}

async function isOwnerAccountId(id: Uuid): Promise<boolean> {
  const owner = await db.query.accountOwners.findFirst({
    columns: { id: true },
    where: { id: { eq: id } },
  });
  return owner != null;
}

/**
 * Exempts requests whose `:id` is the owner's account.
 */
export const isOwnAccount: ViewingHoursExemption = async (c) => {
  const id = c.req.param("id");
  return id != null && isUuid(id) && (await isOwnerAccountId(id));
};

/**
 * Exempts requests whose `:id` is the owner's post.  The owner's boosts of
 * other accounts' posts are not exempted since they show others' content.
 */
export const isOwnPost: ViewingHoursExemption = async (c) => {
  const id = c.req.param("id");
  if (id == null || !isUuid(id)) return false;
  const post = await db.query.posts.findFirst({
    columns: { accountId: true },
    with: { sharing: { columns: { accountId: true } } },
    where: { id: { eq: id } },
  });
  return (
    post != null &&
    (await isOwnerAccountId(post.accountId)) &&
    (post.sharing == null || (await isOwnerAccountId(post.sharing.accountId)))
  );
};

/**
 * Exempts requests whose `:id` is a poll attached to the owner's post.
 */
export const isOwnPoll: ViewingHoursExemption = async (c) => {
  const id = c.req.param("id");
  if (id == null || !isUuid(id)) return false;
  const post = await db.query.posts.findFirst({
    columns: { accountId: true },
    where: { pollId: { eq: id } },
  });
  return post != null && (await isOwnerAccountId(post.accountId));
};
