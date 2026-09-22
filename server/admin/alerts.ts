import { getDebugTutorHealth } from './healthService.js';
let lastAlert = 0;
export function startHealthMonitor() {
  setInterval(async () => {
    try {
      const h = await getDebugTutorHealth(1);
      if (!h.anomalies.length) return;
      if (Date.now() - lastAlert < 30 * 60 * 1000) return;
      lastAlert = Date.now();
      if (!process.env.ALERT_WEBHOOK_URL) return;
      await fetch(process.env.ALERT_WEBHOOK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `Debug Tutor degraded\n${h.anomalies.map(a => `- ${a}`).join('\n')}` }),
      });
    } catch {}
  }, 5 * 60 * 1000);
}
