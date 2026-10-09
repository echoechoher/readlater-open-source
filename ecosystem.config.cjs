module.exports = {
  apps: [
    {
      name: "readlater",
      script: "server.mjs",
      env: {
        HOST: "127.0.0.1",
        PORT: "3000"
      }
    }
  ]
};
