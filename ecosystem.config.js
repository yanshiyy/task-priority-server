// pm2 进程守护配置（可选，用于云服务器）
// 用法：npm i -g pm2 && pm2 start ecosystem.config.js && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'task-priority',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '200M',
      env: {
        PORT: 8788,
        ACCOUNTS: process.env.ACCOUNTS || 'user1,user2,user3,user4,user5',
        DATA_DIR: process.env.DATA_DIR || './data'
      }
    }
  ]
};
