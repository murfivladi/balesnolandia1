// pm2: один процесс — WebSocket-шина и игровой таймер живут в памяти API.
module.exports = {
  apps: [
    {
      name: 'balesnolandia-api',
      cwd: __dirname + '/api',
      script: 'src/server.js',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
      time: true,
    },
  ],
};
