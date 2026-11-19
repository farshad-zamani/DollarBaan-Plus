module.exports = {
  apps: [{
    name: 'DollarBaanPlus',
    script: './server/index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '400M',
    env: {
      NODE_ENV: 'production',
    },
  }],
};
