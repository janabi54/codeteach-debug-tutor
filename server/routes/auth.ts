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
import { requireAuth } from '../middleware/requireAuth.js';
import { openAdminSignupEnabled } from '../util/roles.js';

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

  // Signup can specify role directly (self-service) OR via invite code.
  // - role='instructor' → is_admin = openAdminSignupEnabled() (true unless
  //   DISABLE_OPEN_ADMIN=true is set)
  // - role='student'    → never admin
  // - valid invite code → role = code.role, is_admin = false (invite codes
  //   never grant admin — that would be a privilege-escalation path)
  const requestedRole = (req.body ?? {}).role;
  const rawInvite = (req.body ?? {}).inviteCode;

  let assignedRole: 'student' | 'instructor' = 'student';
  let assignedIsAdmin = false;
  let usedInviteCode: string | null = null;

  if (rawInvite && typeof rawInvite === 'string' && rawInvite.trim().length > 0) {
    const trimmed = rawInvite.trim().toUpperCase();
    const code = await db.inviteCodes.find(trimmed);
    if (!code) {
      return res.status(400).json({ error: 'Invalid invite code.' });
    }
    if (code.usedBy) {
      return res.status(400).json({ error: 'That invite code has already been used.' });
    }
    if (code.expiresAt && code.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ error: 'That invite code has expired.' });
    }
    assignedRole = code.role === 'instructor' ? 'instructor' : 'student';
    assignedIsAdmin = false; // invite codes never grant admin
    usedInviteCode = trimmed;
  } else if (requestedRole === 'instructor') {
    assignedRole = 'instructor';
    assignedIsAdmin = openAdminSignupEnabled();
  }

  const passwordHash = await hashPassword(password);
  const user = await db.users.create({
    email: normalizedEmail,
    passwordHash,
    displayName: displayName.trim(),
    role: assignedRole,
    isAdmin: assignedIsAdmin,
  });

  if (usedInviteCode) {
    await db.inviteCodes.markUsed(usedInviteCode, user.id);
  }

  const token = await createSession(user.id);
  setSessionCookie(res, token);

  res.status(201).json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      isAdmin: user.isAdmin,
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
      isAdmin: user.isAdmin === true,
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
// ─────────────────────────────────────────────────────────────
// DELETE /api/auth/me/account
// Self-service account deletion. Instructors must not own any
// cohorts (they have to delete or transfer them first). Students
// can delete freely. Also kills any active auth sessions.
// ─────────────────────────────────────────────────────────────
router.delete('/me/account', requireAuth, async (req, res) => {
  const user = req.user!;
  const userId = user.id;

  // If the user is an instructor, block if they still own cohorts.
  if (user.role === 'instructor') {
    const owned = await db.cohorts.listByInstructor(userId);
    if (owned.length > 0) {
      return res.status(409).json({
        error: 'You still own ' + owned.length + ' cohort' + (owned.length === 1 ? '' : 's') +
          '. Delete or transfer them before deleting your account.',
        cohorts: owned.map((c) => ({ id: c.id, name: c.name })),
      });
    }
  }

  const counts = db.deletion.purgeAccount(userId);

  db.deletion.recordAudit({
    actorId: userId,
    actorEmail: user.email ?? null,
    scope: 'account',
    targetId: userId,
    targetLabel: user.displayName ?? null,
    counts,
  });

  // Clear the session cookie so the client knows we're logged out.
  clearSessionCookie(res);

  res.json({ ok: true, removed: counts });
});

router.get('/me', async (req, res) => {
  const token = getSessionTokenFromRequest(req);
  if (!token) {
    // Not logged in. Return 200 with null user so the client's
    // auth bootstrap doesn't log a red 401 in the browser console.
    return res.json({ user: null });
  }
  const user = await resolveSession(token);
  if (!user) {
    return res.json({ user: null });
  }
  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      isAdmin: user.isAdmin === true,
    },
  });
});

export default router;
