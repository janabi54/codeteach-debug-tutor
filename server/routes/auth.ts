import express from 'express';
import { db } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  createSession,
  resolveSession,
  destroySession,
} from '../auth/sessions.js';
import {
  setSessionCookie,
  clearSessionCookie,
  getSessionTokenFromRequest,
} from '../auth/cookies.js';
import {
  checkLimit,
  recordFailure,
  clearLimit,
  clientIp,
} from '../middleware/rateLimit.js';

const router = express.Router();

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─────────────────────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { email, password, displayName } = req.body ?? {};
  const ip = clientIp(req);
  const rlKey = `register:${ip}`;

  const preCheck = checkLimit({ key: rlKey });
  if (!preCheck.allowed) {
    res.set('Retry-After', String(preCheck.retryAfterSeconds));
    return res.status(429).json({
      error: 'Too many registration attempts. Try again later.',
      retryAfterSeconds: preCheck.retryAfterSeconds,
    });
  }

  res.on('finish', () => {
    if (res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 429) {
      recordFailure({ key: rlKey });
    }
    if (res.statusCode === 201) {
      clearLimit(rlKey);
    }
  });

  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return res
      .status(400)
      .json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  if (typeof displayName !== 'string' || displayName.trim().length < 1) {
    return res.status(400).json({ error: 'A display name is required.' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await db.users.findByEmail(normalizedEmail);
  if (existing) {
    return res
      .status(409)
      .json({ error: 'An account with that email already exists.' });
  }

  const passwordHash = await hashPassword(password);
  const user = await db.users.create({
    email: normalizedEmail,
    passwordHash,
    displayName: displayName.trim(),
    role: 'student',
  });

  const token = await createSession(user.id);
  setSessionCookie(res, token);

  res.status(201).json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    },
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const ip = clientIp(req);
  const normalizedEmail = email.trim().toLowerCase();
  const rlKey = `login:${normalizedEmail}|${ip}`;

  const preCheck = checkLimit({ key: rlKey });
  if (!preCheck.allowed) {
    res.set('Retry-After', String(preCheck.retryAfterSeconds));
    return res.status(429).json({
      error: 'Too many failed login attempts. Try again later.',
      retryAfterSeconds: preCheck.retryAfterSeconds,
    });
  }

  const user = await db.users.findByEmail(normalizedEmail);

  // Timing-safe: verify against a dummy hash if user is missing
  const hash = user?.passwordHash ?? '$2b$12$invalid.hash.for.timing.equality';
  const ok = await verifyPassword(password, hash);

  if (!user || !ok) {
    const state = recordFailure({ key: rlKey });
    if (!state.allowed) {
      res.set('Retry-After', String(state.retryAfterSeconds));
      return res.status(429).json({
        error: 'Too many failed login attempts. Try again later.',
        retryAfterSeconds: state.retryAfterSeconds,
      });
    }
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  clearLimit(rlKey);

  const token = await createSession(user.id);
  setSessionCookie(res, token);

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    },
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const token = getSessionTokenFromRequest(req);
  if (token) {
    await destroySession(token);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  const token = getSessionTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  const user = await resolveSession(token);
  if (!user) {
    return res.status(401).json({ error: 'Session expired or invalid.' });
  }
  res.json({ user });
});

export default router;
