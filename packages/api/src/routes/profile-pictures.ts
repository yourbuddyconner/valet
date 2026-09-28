/**
 * Profile-picture upload and public serving routes.
 *
 * Uploads use the configured BlobStore. The server validates and rewrites
 * every accepted image to WebP before storage. Public reads use only a
 * server-derived hash, so Slack can fetch assistant avatars without a Valet
 * session and clients cannot select another principal's storage key.
 */
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash, randomBytes } from "node:crypto";
import type sharpType from "sharp";
import { assistantOwner, canAdministerAssistantOwner } from "../assistants/access.js";
import { loadAssistant, WORKSPACE_ASSISTANT_MESSAGE } from "../assistants/service.js";
import { publicUrlFromEnv } from "../channels/host.js";
import type { AppEnv } from "../env.js";
import { requireUser } from "../middleware/auth.js";
import { users } from "../schema/index.js";
import {
  PROFILE_PICTURE_MAX_BYTES,
  PROFILE_PICTURE_MAX_DIMENSION,
  PROFILE_PICTURE_OUTPUT_MAX_DIMENSION,
  type ProfilePictureUploadResponse,
} from "../wire/types.js";

const REQUEST_OVERHEAD_BYTES = 64 * 1024;
const UPLOAD_BODY_MAX_BYTES = PROFILE_PICTURE_MAX_BYTES + REQUEST_OVERHEAD_BYTES;
const ACCEPTED_TYPES = new Map<string, string>([
  ["image/jpeg", "jpeg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
] as const);
const HASH_PATTERN = /^[a-f0-9]{64}$/;

type PictureKind = "users" | "assistants";
type SharpFactory = typeof sharpType;

declare global {
  var __VALET_SHARP__: SharpFactory | undefined;
}

async function loadSharp(): Promise<SharpFactory> {
  return globalThis.__VALET_SHARP__ ?? (await import("sharp")).default;
}

function pictureHash(kind: PictureKind, id: string, version: string): string {
  return createHash("sha256").update(`valet-profile-picture:${kind}:${id}:${version}`).digest("hex");
}

function blobKey(kind: PictureKind, hash: string): string {
  return `profile-pictures/${kind}/${hash}.webp`;
}

function ownedBlobKey(avatarUrl: string | null | undefined, kind: PictureKind, id: string): string | undefined {
  if (!avatarUrl) return undefined;
  try {
    const url = new URL(avatarUrl);
    const version = url.searchParams.get("v");
    const match = url.pathname.match(new RegExp(`^/avatars/${kind}/([a-f0-9]{64})\\.webp$`));
    if (!version || !match || pictureHash(kind, id, version) !== match[1]) return undefined;
    return blobKey(kind, match[1]);
  } catch {
    return undefined;
  }
}

function authUrlOrigin(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.BETTER_AUTH_URL) return undefined;
  try {
    return new URL(env.BETTER_AUTH_URL).origin;
  } catch {
    return undefined;
  }
}

function pictureUrl(c: Context<AppEnv>, kind: PictureKind, hash: string, version: string): string {
  const base = publicUrlFromEnv(process.env) ?? authUrlOrigin(process.env) ?? new URL(c.req.url).origin;
  return `${base.replace(/\/+$/, "")}/avatars/${kind}/${hash}.webp?v=${version}`;
}

async function readAndNormalizeImage(c: Context<AppEnv>): Promise<Uint8Array | Response> {
  const length = c.req.header("content-length");
  if (length !== undefined) {
    const parsed = Number(length);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return c.json({ error: "Content-Length is invalid. Upload the image again." }, 400);
    }
    if (parsed > UPLOAD_BODY_MAX_BYTES) {
      return c.json(
        { error: `Profile pictures are limited to ${PROFILE_PICTURE_MAX_BYTES / (1024 * 1024)} MB. Choose a smaller image.` },
        413,
      );
    }
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "The upload is not valid multipart form-data. Upload the image again." }, 400);
  }
  const part = form.get("file");
  if (!(part instanceof File)) {
    return c.json({ error: "The file field is missing. Choose an image and upload it again." }, 400);
  }
  if (part.size === 0) {
    return c.json({ error: "The image is empty. Choose a valid image." }, 400);
  }
  if (part.size > PROFILE_PICTURE_MAX_BYTES) {
    return c.json(
      { error: `Profile pictures are limited to ${PROFILE_PICTURE_MAX_BYTES / (1024 * 1024)} MB. Choose a smaller image.` },
      413,
    );
  }
  const expectedFormat = ACCEPTED_TYPES.get(part.type);
  if (!expectedFormat) {
    return c.json({ error: "Use a JPEG, PNG, or WebP image." }, 415);
  }

  const input = new Uint8Array(await part.arrayBuffer());
  try {
    const sharp = await loadSharp();
    const image = sharp(input, {
      failOn: "error",
      limitInputPixels: PROFILE_PICTURE_MAX_DIMENSION * PROFILE_PICTURE_MAX_DIMENSION,
      animated: false,
    });
    const metadata = await image.metadata();
    if (metadata.format !== expectedFormat) {
      return c.json({ error: "The file content does not match its image type. Choose a valid image." }, 415);
    }
    if (
      metadata.width === undefined ||
      metadata.height === undefined ||
      metadata.width < 1 ||
      metadata.height < 1 ||
      metadata.width > PROFILE_PICTURE_MAX_DIMENSION ||
      metadata.height > PROFILE_PICTURE_MAX_DIMENSION ||
      (metadata.pages ?? 1) !== 1
    ) {
      return c.json(
        { error: `Profile pictures must be one image no larger than ${PROFILE_PICTURE_MAX_DIMENSION} × ${PROFILE_PICTURE_MAX_DIMENSION} pixels.` },
        400,
      );
    }
    return new Uint8Array(
      await image
        .rotate()
        .resize({
          width: PROFILE_PICTURE_OUTPUT_MAX_DIMENSION,
          height: PROFILE_PICTURE_OUTPUT_MAX_DIMENSION,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 88 })
        .toBuffer(),
    );
  } catch {
    return c.json({ error: "The image is malformed or too large to decode. Choose a valid image." }, 400);
  }
}

async function storePicture(
  c: Context<AppEnv>,
  kind: PictureKind,
  id: string,
  previousAvatarUrl: string | null | undefined,
  persist: (avatarUrl: string) => Promise<void>,
): Promise<Response> {
  const normalized = await readAndNormalizeImage(c);
  if (normalized instanceof Response) return normalized;

  // A fresh object key prevents concurrent uploads or a failed database write
  // from replacing the bytes referenced by the currently persisted URL.
  const version = randomBytes(12).toString("base64url");
  const hash = pictureHash(kind, id, version);
  const key = blobKey(kind, hash);
  const avatarUrl = pictureUrl(c, kind, hash, version);
  await c.var.providers.blobs.put(key, normalized, { contentType: "image/webp" });
  try {
    await persist(avatarUrl);
  } catch (error) {
    await c.var.providers.blobs.delete(key).catch(() => undefined);
    throw error;
  }
  const previousKey = ownedBlobKey(previousAvatarUrl, kind, id);
  if (previousKey && previousKey !== key) {
    await c.var.providers.blobs.delete(previousKey).catch(() => undefined);
  }
  const body: ProfilePictureUploadResponse = { avatarUrl };
  return c.json(body);
}

export const profilePicturesPublicRouter = new Hono<AppEnv>();
profilePicturesPublicRouter.get("/:kind/:filename", async (c) => {
  const kind = c.req.param("kind");
  const filename = c.req.param("filename");
  const hash = filename?.endsWith(".webp") ? filename.slice(0, -5) : undefined;
  if ((kind !== "users" && kind !== "assistants") || hash === undefined || !HASH_PATTERN.test(hash)) {
    return c.json({ error: "profile picture not found" }, 404);
  }
  const stored = await c.var.providers.blobs.get(blobKey(kind, hash));
  if (!stored) return c.json({ error: "profile picture not found" }, 404);
  return new Response(stored.data, {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

export const profilePicturesRouter = new Hono<AppEnv>();

const limitUploadBody = bodyLimit({
  maxSize: UPLOAD_BODY_MAX_BYTES,
  onError: (c) =>
    c.json(
      { error: `Profile pictures are limited to ${PROFILE_PICTURE_MAX_BYTES / (1024 * 1024)} MB. Choose a smaller image.` },
      413,
    ),
});

profilePicturesRouter.post("/me/avatar", limitUploadBody, async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const [current] = await c.var.providers.db
    .select({ image: users.image })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  return storePicture(c, "users", user.id, current?.image, async (avatarUrl) => {
    await c.var.providers.db.update(users).set({ image: avatarUrl }).where(eq(users.id, user.id));
  });
});

profilePicturesRouter.post("/assistants/:id/avatar", limitUploadBody, async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const row = await loadAssistant(c.var.providers.db, c.req.param("id"));
  if (!row || row.orgId !== user.orgId) return c.json({ error: "assistant not found" }, 404);
  if (!(await canAdministerAssistantOwner(c.var.providers.db, assistantOwner(row), c.var.principal))) {
    return c.json({ error: "assistant not found" }, 404);
  }
  return c.json({ error: WORKSPACE_ASSISTANT_MESSAGE }, 409);
});
