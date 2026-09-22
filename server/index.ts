import express from 'express';
import debugTutorRoutes from './routes/debugTutor.js';
import adminRoutes from './routes/admin.js';
import { startHealthMonitor } from './admin/alerts.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));
app.use('/api/debug-tutor', debugTutorRoutes);
app.use('/api/admin', adminRoutes);

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`CodeTeach Debug Tutor listening on :${PORT}`);
  if (process.env.NODE_ENV === 'production') startHealthMonitor();
});
