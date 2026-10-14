import argon2 from "argon2";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../../config/env.js";
import { deliverPasswordReset } from "../../infrastructure/email/notifier.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { HttpError } from "../../middleware/errors.js";
import { generateResetToken, hashResetToken } from "./password-reset.js";
import { authenticatedSessionId, authenticatedUserId, requireAuth } from "./auth.middleware.js";

export const authRouter = Router();

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
}).strict();

async function createSession(userId: string) {
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
  const session = await prisma.session.create({ data: { userId, expiresAt } });
  const token = jwt.sign(
    { sid: session.id },
    env.JWT_SECRET,
    { subject: userId, issuer: "design-to-elementor-api", expiresIn: "12h" },
  );
  return { token, expiresAt };
}

authRouter.post("/register", async (req, res) => {
  const body = credentialsSchema.parse(req.body);
  const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
  try {
    const user = await prisma.user.create({
      data: { email: body.email, passwordHash },
      select: { id: true, email: true },
    });
    const session = await createSession(user.id);
    res.status(201).json({ user, ...session });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      throw new HttpError(409, "EMAIL_IN_USE", "An account with this email already exists");
    }
    throw error;
  }
});

authRouter.post("/login", async (req, res) => {
  const body = credentialsSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (!user || !(await argon2.verify(user.passwordHash, body.password))) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }
  res.json({
    user: { id: user.id, email: user.email },
    ...await createSession(user.id),
  });
});

const forgotPasswordSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
}).strict();

const resetPasswordSchema = z.object({
  token: z.string().trim().min(20).max(256),
  password: z.string().min(12).max(128),
}).strict();

authRouter.post("/forgot-password", async (req, res) => {
  const body = forgotPasswordSchema.parse(req.body);
  const user = await prisma.user.findUnique({
    where: { email: body.email },
    select: { id: true, email: true },
  });

  // Always respond the same way so the endpoint cannot be used to discover
  // which email addresses have accounts. A reset token is only created and
  // delivered when the account actually exists.
  if (user) {
    const token = generateResetToken();
    const expiresAt = new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000);
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashResetToken(token), expiresAt },
    });
    await deliverPasswordReset({ email: user.email, token, expiresAt });
    // Development has no mail provider, so return the token so the flow is
    // testable end to end. Production responses never include the token.
    if (env.NODE_ENV !== "production") {
      res.status(202).json({ status: "reset_link_sent", resetToken: token, expiresAt });
      return;
    }
  }

  res.status(202).json({ status: "reset_link_sent" });
});

authRouter.post("/reset-password", async (req, res) => {
  const body = resetPasswordSchema.parse(req.body);
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(body.token) },
    select: { id: true, userId: true, expiresAt: true, usedAt: true },
  });
  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(400, "INVALID_RESET_TOKEN", "This password reset link is invalid or has expired");
  }

  const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
  const now = new Date();
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: now } }),
    prisma.passwordResetToken.updateMany({
      where: { userId: record.userId, usedAt: null },
      data: { usedAt: now },
    }),
    prisma.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: now } }),
  ]);

  res.json({ status: "password_reset" });
});

authRouter.post("/logout", requireAuth, async (req, res) => {
  await prisma.session.update({
    where: { id: authenticatedSessionId(req) },
    data: { revokedAt: new Date() },
  });
  res.status(204).end();
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: authenticatedUserId(req) },
    select: { id: true, email: true, createdAt: true },
  });
  if (!user) throw new HttpError(401, "INVALID_SESSION", "Session is no longer valid");
  res.json({ user });
});
