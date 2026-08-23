// Minimal electron stub so the engine can run headless in plain node for testing.
const os = require("node:os");
const path = require("node:path");

module.exports = {
  app: {
    getPath: () => path.join(os.tmpdir(), "rom-trader-test"),
    getVersion: () => "test",
  },
};
