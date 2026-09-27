import express from 'express';
import cookieParser from 'cookie-parser';
import debugTutorRoutes from './routes/debugTutor.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import { startHealthMonitor } from './admin/alerts.js';
import { bootstrapInstructor } from './auth/bootstrap.js';
import { pruneExpiredSessions } from './auth/sessions.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static('public'));

app.use('/api/auth', authRoutes);
app.use('/api/debug-tutor', debugTutorRoutes);
app.use('/api/admin', adminRoutes);

const PORT = Number(process.env.PORT ?? 3001);

async function main() {
  await bootstrapInstructor();
  await pruneExpiredSessions();

  app.listen(PORT, () => {
    console.log(`CodeTeach Debug Tutor listening on :${PORT}`);
    if (process.env.NODE_ENV === 'production') startHealthMonitor();
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
