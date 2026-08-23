/**
 * Verifies the credential vault against the real Windows DPAPI, which the
 * playtest cannot do: that suite swaps in a toy cipher so it can run in plain
 * node. This one runs inside Electron so safeStorage is genuine.
 *
 *   npm run dpapi
 */
import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SANDBOX = path.join(os.tmpdir(), `rom-dpapi-${Date.now()}`);
fs.mkdirSync(SANDBOX, { recursive: true });
app.setPath("userData", SANDBOX);

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIsecret999\n-----END RSA PRIVATE KEY-----";
const KEY_ID = "11112222-3333-4444-5555-666677778888";

void app.whenReady().then(async () => {
  // Imported after the userData override so the vault resolves the sandbox.
  const {
    clearCredentials,
    credentialStatus,
    encryptionAvailable,
    loadCredentials,
    migrateLegacyCredentials,
    saveCredentials,
  } = await import("../electron/engine/credentials");

  console.log(`\n== real DPAPI (${process.platform}) ==`);
  console.log(`  sandbox: ${SANDBOX}`);

  check("Windows offers a credential store", encryptionAvailable() === true);
  check("safeStorage round-trips a string", (() => {
    const blob = safeStorage.encryptString("canary");
    return safeStorage.decryptString(blob) === "canary";
  })());

  saveCredentials({ apiKeyId: KEY_ID, apiPrivateKeyPem: PEM });
  check("key survives a real encrypt/decrypt cycle", loadCredentials().apiPrivateKeyPem === PEM);
  check("status sees the key", credentialStatus().configured === true);

  const raw = fs.readFileSync(path.join(SANDBOX, "credentials.dat"), "utf-8");
  check("ciphertext hides the PEM", !raw.includes("BEGIN RSA") && !raw.includes("MIIsecret"));
  check("ciphertext hides the key id", !raw.includes(KEY_ID));
  check("file is a v1 dpapi envelope", raw.includes('"enc":"dpapi"') && raw.includes('"v":1'));

  // Prove the bytes are genuinely DPAPI-wrapped and not just encoded.
  const envelope = JSON.parse(raw) as { data: string };
  const decoded = Buffer.from(envelope.data, "base64").toString("utf-8");
  check("base64 alone does not reveal the key", !decoded.includes("BEGIN RSA"));

  // A vault from another Windows account decrypts to nothing; simulate that by
  // corrupting the ciphertext, which must fail closed rather than throw.
  clearCredentials();
  fs.writeFileSync(
    path.join(SANDBOX, "credentials.dat"),
    JSON.stringify({ v: 1, enc: "dpapi", data: Buffer.from("not really dpapi").toString("base64") }),
    "utf-8",
  );
  let threw = false;
  let creds = { apiKeyId: "x", apiPrivateKeyPem: "x" };
  try {
    creds = loadCredentials();
  } catch {
    threw = true;
  }
  check("an unreadable vault does not throw", !threw);
  check("an unreadable vault yields no key", creds.apiKeyId === "" && creds.apiPrivateKeyPem === "");
  check("an unreadable vault is reported to the user", (credentialStatus().error ?? "").length > 0);

  // Migration, against real encryption this time.
  clearCredentials();
  fs.writeFileSync(
    path.join(SANDBOX, "settings.json"),
    JSON.stringify({ apiKeyId: KEY_ID, apiPrivateKeyPem: PEM, tradeSizeUsd: 21 }, null, 2),
    "utf-8",
  );
  check("migration runs", migrateLegacyCredentials() === true);
  check("migrated key decrypts", loadCredentials().apiPrivateKeyPem === PEM);
  const settingsAfter = fs.readFileSync(path.join(SANDBOX, "settings.json"), "utf-8");
  check("plaintext is gone from settings.json", !settingsAfter.includes("BEGIN RSA"));
  check("key id is gone from settings.json", !settingsAfter.includes(KEY_ID));
  check("other settings survived", settingsAfter.includes("21"));

  fs.rmSync(SANDBOX, { recursive: true, force: true });

  console.log(`\n${"=".repeat(52)}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  - ${f}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
