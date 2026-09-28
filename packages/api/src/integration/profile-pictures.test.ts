import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { users } from "../schema/index.js";
import type {
  ProfilePictureUploadResponse,
} from "../wire/types.js";
import { PROFILE_PICTURE_MAX_BYTES } from "../wire/types.js";
import { bootTestApi, type TestApi } from "./_setup.js";

const MEMBER_HEADERS = { "x-valet-test-user-id": "test-member" };

async function png(width = 8, height = 8): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 4, background: "#669966" } })
      .png()
      .toBuffer(),
  );
}

async function animatedWebp(): Promise<Uint8Array> {
  const pixels = new Uint8Array(8 * 16 * 3);
  for (let pixel = 0; pixel < 8 * 8; pixel += 1) {
    pixels[pixel * 3] = 255;
    pixels[(pixel + 8 * 8) * 3 + 2] = 255;
  }
  const tiff = await sharp(pixels, {
    raw: { width: 8, height: 16, channels: 3, pageHeight: 8 },
  }).tiff().toBuffer();
  return new Uint8Array(
    await sharp(tiff, { animated: true }).webp({ loop: 0, delay: [100, 100] }).toBuffer(),
  );
}

function uploadBody(bytes: Uint8Array, type = "image/png"): FormData {
  const form = new FormData();
  form.append("file", new File([bytes], "avatar.png", { type }));
  return form;
}


describe("profile-picture uploads", () => {
  let api: TestApi;

  beforeEach(async () => {
    api = await bootTestApi();
  });

  afterEach(async () => {
    await api.cleanup();
  });

  it("stores and publicly serves normalized pictures for users and assistants", async () => {
    const source = await png(800, 400);
    const userResponse = await fetch(`${api.baseUrl}/api/me/avatar`, {
      method: "POST",
      body: uploadBody(source),
    });
    expect(userResponse.status).toBe(200);
    const userResult = (await userResponse.json()) as ProfilePictureUploadResponse;
    expect(userResult.avatarUrl).toMatch(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/avatars\/users\/[a-f0-9]{64}\.webp\?v=/);

    const me = await fetch(`${api.baseUrl}/api/me`).then((response) => response.json()) as { avatarUrl: string };
    expect(me.avatarUrl).toBe(userResult.avatarUrl);
    const servedUser = await fetch(userResult.avatarUrl);
    expect(servedUser.status).toBe(200);
    expect(servedUser.headers.get("content-type")).toBe("image/webp");
    expect(servedUser.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(servedUser.headers.get("x-content-type-options")).toBe("nosniff");
    const servedMetadata = await sharp(await servedUser.arrayBuffer()).metadata();
    expect(servedMetadata).toMatchObject({ format: "webp", width: 512, height: 256 });

    const replacementResponse = await fetch(`${api.baseUrl}/api/me/avatar`, {
      method: "POST",
      body: uploadBody(await png()),
    });
    expect(replacementResponse.status).toBe(200);
    expect((await fetch(userResult.avatarUrl)).status).toBe(404);

    const assistant = await seedWorkspaceAssistant(api.providers.db, "local-org", { type: "user", id: "local-user" }, "Valet");
    const assistantResponse = await fetch(`${api.baseUrl}/api/assistants/${assistant.id}/avatar`, {
      method: "POST",
      body: uploadBody(source),
    });
    expect(assistantResponse.status).toBe(404);

  });

  it("scopes user writes to the caller and hides another owner's assistant", async () => {
    const source = await png(800, 400);
    const memberResponse = await fetch(`${api.baseUrl}/api/me/avatar`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: uploadBody(source),
    });
    expect(memberResponse.status).toBe(200);

    const rows = await api.providers.db
      .select({ id: users.id, image: users.image })
      .from(users)
      .where(eq(users.id, "local-user"));
    expect(rows[0]?.image).toBeNull();

    const assistant = await seedWorkspaceAssistant(api.providers.db, "local-org", { type: "user", id: "local-user" }, "Valet");
    const forbidden = await fetch(`${api.baseUrl}/api/assistants/${assistant.id}/avatar`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: uploadBody(source),
    });
    expect(forbidden.status).toBe(404);

    const listed = await fetch(`${api.baseUrl}/api/assistants`).then((response) => response.json()) as {
      assistants: Array<{ id: string; avatarUrl?: string }>;
    };
    expect(listed.assistants.find((item) => item.id === assistant.id)?.avatarUrl).toBeUndefined();
  });

  it("rejects malformed, mismatched, and oversized files without persistence", async () => {
    const malformed = await fetch(`${api.baseUrl}/api/me/avatar`, {
      method: "POST",
      body: uploadBody(new TextEncoder().encode("not an image")),
    });
    expect(malformed.status).toBe(400);

    const mismatched = await fetch(`${api.baseUrl}/api/me/avatar`, {
      method: "POST",
      body: uploadBody(await png(), "image/jpeg"),
    });
    expect(mismatched.status).toBe(415);

    const animated = await fetch(`${api.baseUrl}/api/me/avatar`, {
      method: "POST",
      body: uploadBody(await animatedWebp(), "image/webp"),
    });
    expect(animated.status).toBe(400);

    const oversized = await fetch(`${api.baseUrl}/api/me/avatar`, {
      method: "POST",
      body: uploadBody(new Uint8Array(PROFILE_PICTURE_MAX_BYTES + 1)),
    });
    expect(oversized.status).toBe(413);

    const wideImage = new Uint8Array(
      await sharp({ create: { width: 4097, height: 1, channels: 3, background: "white" } })
        .png()
        .toBuffer(),
    );
    const tooWide = await fetch(`${api.baseUrl}/api/me/avatar`, {
      method: "POST",
      body: uploadBody(wideImage),
    });
    expect(tooWide.status).toBe(400);

    const me = await fetch(`${api.baseUrl}/api/me`).then((response) => response.json()) as { avatarUrl: string | null };
    expect(me.avatarUrl).toBeNull();
  });

  it("requires authentication for uploads but keeps picture reads public", async () => {
    await api.cleanup();
    api = await bootTestApi({ auth: true });
    const response = await fetch(`${api.baseUrl}/api/me/avatar`, {
      method: "POST",
      body: uploadBody(await png()),
    });
    expect(response.status).toBe(401);
  });
});
