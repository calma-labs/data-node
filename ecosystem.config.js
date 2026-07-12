module.exports = {
  apps: [
    {
      name: 'data-node-poc',
      script: 'server.js',
      instances: 1,
      exec_mode: 'cluster',
      wait_ready: true,
      listen_timeout: 5000,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 2000,
      max_restarts: 10,
      min_uptime: '5s',
    },
  ],
};
