import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initMail } from './services/mail.js';
import { sendDueTaskReminders } from './services/reminders.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import orgRoutes from './routes/orgs.js';
import seasonRoutes from './routes/seasons.js';
import settingsRoutes from './routes/settings.js';
import shulRoutes from './routes/shuls.js';
import applicantRoutes from './routes/applicants.js';
import cardRoutes from './routes/cards.js';
import storeRoutes from './routes/stores.js';
import formRoutes from './routes/forms.js';
import dashboardRoutes from './routes/dashboard.js';
import taskRoutes from './routes/tasks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3002;
const FRONTEND_DIR = join(__dirname, '..', 'frontend');

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '15mb' })); // e-signature PNGs are base64 in JSON bodies
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 2000 }));

initMail();

// Public runtime config for the frontend — safe, publishable keys only.
// GOOGLE_MAPS_API_KEY should be restricted to this domain in Google Cloud Console.
app.get('/api/config', (req, res) => {
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    appName: process.env.ORG_NAME || "Shmachas Rechag - Kupat Ha'ir",
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/orgs', orgRoutes);
app.use('/api/seasons', seasonRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/shuls', shulRoutes);
app.use('/api/applicants', applicantRoutes);
app.use('/api/cards', cardRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/forms', formRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/tasks', taskRoutes);

// Signed/generated PDFs and uploaded logos.
app.use('/uploads/contracts', express.static(join(process.env.DATA_DIR || join(process.cwd(), 'data'), 'contracts')));
app.use('/uploads/logos', express.static(join(process.env.DATA_DIR || join(process.cwd(), 'data'), 'logos')));

app.use(express.static(FRONTEND_DIR));

app.get('/', (req, res) => res.sendFile(join(FRONTEND_DIR, 'index.html')));

// SPA-ish fallback for clean admin URLs without extensions.
app.get(/^\/(?!api\/|uploads\/).*/, (req, res, next) => {
  if (req.path.includes('.')) return next(); // let express.static 404 real missing assets
  const candidate = join(FRONTEND_DIR, req.path + '.html');
  res.sendFile(candidate, (err) => { if (err) res.status(404).sendFile(join(FRONTEND_DIR, 'index.html')); });
});

app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`[ecards] listening on :${PORT}`));

// Due-date task reminders — checked periodically (single-instance in-process
// interval; see services/reminders.js for why).
const REMINDER_INTERVAL_MS = 30 * 60 * 1000;
setInterval(() => { sendDueTaskReminders().catch(e => console.error('[reminders] check failed', e.message)); }, REMINDER_INTERVAL_MS);
setTimeout(() => { sendDueTaskReminders().catch(e => console.error('[reminders] check failed', e.message)); }, 15 * 1000);
