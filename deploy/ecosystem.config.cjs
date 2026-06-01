// PM2 config for production (single droplet).
//
// Paths resolve relative to THIS file, so it works wherever you clone the repo.
// Unlike the dev ecosystem.config.cjs, this runs ONLY the server — in production
// the client is built once (`npm run build`) and served as static files by nginx,
// so there is no Vite dev process.
//
// Usage from the repo root:
//   mkdir -p logs
//   pm2 start deploy/ecosystem.config.cjs
//   pm2 save && pm2 startup     # survive reboots

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'whale-server',
      script: 'src/index.js',
      cwd: path.join(ROOT, 'server'),
      interpreter: 'node',
      // Lowered from 2048 -> 1536 to fit a 2GB droplet, leaving headroom for the
      // OS, better-sqlite3's page cache, and nginx. Pair with a 2GB swap file.
      interpreter_args: '--max-old-space-size=1536',
      env_file: path.join(ROOT, '.env'),
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: path.join(ROOT, 'logs/server.log'),
      error_file: path.join(ROOT, 'logs/server-error.log'),
    },
  ],
};
