module.exports = {
  apps : [{
    name: 'time-thumbnail-nodejs',
    script: 'app.mjs', // Your entry point file
    args: '--max-memory-restart 200M --max-old-space-size=2048 --cron-restart="0 8 * * *"', // Any arguments your application needs
    instances: 1,
    autorestart: true,
    watch: true,
    max_memory_restart: '8G',
    node_args: '' // Enable remote debugging on all network interfaces
  }],
};