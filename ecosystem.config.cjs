module.exports = {
  apps: [
    {
      name: 'whale-server',
      script: 'src/index.js',
      cwd: '/Users/claude_bot/whale-tracker/whale-tracker/server',
      interpreter: 'node',
      interpreter_args: '--max-old-space-size=2048',
      env_file: '/Users/claude_bot/whale-tracker/whale-tracker/.env',
      watch: false,
      autorestart: true,
      restart_delay: 5000,   // wait 5s before restarting after a crash
      max_restarts: 10,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '/Users/claude_bot/whale-tracker/whale-tracker/logs/server.log',
      error_file: '/Users/claude_bot/whale-tracker/whale-tracker/logs/server-error.log',
    },
    {
      name: 'whale-client',
      script: 'node_modules/.bin/vite',
      cwd: '/Users/claude_bot/whale-tracker/whale-tracker/client',
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '/Users/claude_bot/whale-tracker/whale-tracker/logs/client.log',
      error_file: '/Users/claude_bot/whale-tracker/whale-tracker/logs/client-error.log',
    },
  ],
};
