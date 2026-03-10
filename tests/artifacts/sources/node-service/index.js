// synth-demo-api — minimal Express service for integration testing
const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;
const DB_HOST = process.env.DB_HOST || 'localhost';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.1.0', uptime: process.uptime() });
});

app.get('/api/status', (req, res) => {
  res.json({
    service: 'synth-demo-api',
    env: process.env.APP_ENV || 'unknown',
    db: DB_HOST,
    cache: REDIS_URL,
  });
});

app.listen(PORT, () => {
  console.log(`synth-demo-api listening on port ${PORT}`);
  console.log(`  DB_HOST:   ${DB_HOST}`);
  console.log(`  REDIS_URL: ${REDIS_URL}`);
});
