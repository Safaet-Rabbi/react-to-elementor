import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHash } from "node:crypto";

const deliverPasswordReset = vi.fn();
vi.mock("../src/infrastructure/email/notifier.js", () => ({
  deliverPasswordReset: (...args: unknown[]) => deliverPasswordReset(...args),
}));

vi.mock("../src/infrastructure/database/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    passwordResetToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    session: { updateMany: vi.fn() },
    $transaction: vi.fn(async (operations: unknown[]) => Promise.all(operations as Promise<unknown>[])),
    $disconnect: vi.fn(),
  },
}));

import { createApp } from "../src/app.js";
import { prisma } from "../src/infrastructure/database/prisma.js";

const app = createApp();

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

beforeEach(() => {
  vi.mocked(prisma.user.findUnique).mockReset();
  vi.mocked(prisma.user.update).mockReset();
  vi.mocked(prisma.passwordResetToken.create).mockReset();
  vi.mocked(prisma.passwordResetToken.findUnique).mockReset();
  vi.mocked(prisma.passwordResetToken.update).mockReset();
  vi.mocked(prisma.passwordResetToken.updateMany).mockReset();
  vi.mocked(prisma.session.updateMany).mockReset();
  deliverPasswordReset.mockReset();
});

describe("Password reset endpoints", () => {
  it("does not reveal whether an account exists and always returns 202", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);

    const unknown = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: "nobody@example.com" });
    expect(unknown.status).toBe(202);
    expect(unknown.body.status).toBe("reset_link_sent");
    expect(unknown.body.resetToken).toBeUndefined();
    expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
  });

  it("stores only a hash of the token and returns it for local delivery in development", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "user-1", email: "user@example.com" } as never);

    const response = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: "User@Example.com" });
    expect(response.status).toBe(202);
    expect(typeof response.body.resetToken).toBe("string");

    expect(prisma.passwordResetToken.create).toHaveBeenCalledTimes(1);
    const stored = vi.mocked(prisma.passwordResetToken.create).mock.calls[0]![0];
    expect(stored.data.userId).toBe("user-1");
    expect(stored.data.tokenHash).toBe(hashToken(response.body.resetToken));
    expect(stored.data.tokenHash).not.toContain(response.body.resetToken);

    expect(deliverPasswordReset).toHaveBeenCalledTimes(1);
    expect(deliverPasswordReset.mock.calls[0]![0]).toMatchObject({ email: "user@example.com" });
  });

  it("rejects an invalid reset token without touching the password", async () => {
    vi.mocked(prisma.passwordResetToken.findUnique).mockResolvedValue(null as never);

    const response = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: "invalid-token-value-that-is-long-enough", password: "brand-new-password" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_RESET_TOKEN");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an already-used reset token", async () => {
    vi.mocked(prisma.passwordResetToken.findUnique).mockResolvedValue({
      id: "reset-1",
      userId: "user-1",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: new Date(),
    } as never);

    const response = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: "some-valid-token-value", password: "brand-new-password" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_RESET_TOKEN");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("updates the password, consumes all outstanding tokens, and revokes sessions", async () => {
    vi.mocked(prisma.passwordResetToken.findUnique).mockResolvedValue({
      id: "reset-1",
      userId: "user-1",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    } as never);

    const response = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: "some-valid-token-value", password: "brand-new-password" });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("password_reset");

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: expect.objectContaining({ passwordHash: expect.any(String) }),
      }),
    );
    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1", usedAt: null } }),
    );
    expect(prisma.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1", revokedAt: null } }),
    );
  });

  it("rejects a password shorter than the 12-character minimum", async () => {
    const response = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: "some-valid-token-value", password: "short" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("keeps password recovery reachable even after sign-in attempts are rate limited", async () => {
    // Fresh app => fresh in-memory limiter buckets, isolated from other tests.
    const isolatedApp = createApp();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);

    const badLogin = () => request(isolatedApp).post("/api/v1/auth/login").send({ email: "a@example.com", password: "wrong-password" });
    // Exhaust the shared auth bucket (limit is 10 per 15 minutes).
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await badLogin()).status).toBe(401);
    }
    expect((await badLogin()).status).toBe(429);
    expect((await badLogin()).body.error.code).toBe("RATE_LIMITED");

    // The recovery endpoint uses a separate bucket, so it is still available.
    const forgot = await request(isolatedApp).post("/api/v1/auth/forgot-password").send({ email: "a@example.com" });
    expect(forgot.status).toBe(202);
  });
});
