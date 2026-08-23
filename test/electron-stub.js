// Minimal electron stub so the engine can run headless in plain node for testing.
const os = require("node:os");
const path = require("node:path");

// Stands in for DPAPI. Not secure and not meant to be — it only has to be
// reversible so the vault's save/load/migrate paths are exercised, and
// distinguishable from plaintext so a test can prove the key is not readable.
const XOR = 0x5a;

module.exports = {
  app: {
    getPath: () => path.join(os.tmpdir(), "rom-trader-test"),
    getVersion: () => "test",
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(Buffer.from(s, "utf-8").map((b) => b ^ XOR)),
    decryptString: (buf) => Buffer.from(buf.map((b) => b ^ XOR)).toString("utf-8"),
  },
};
