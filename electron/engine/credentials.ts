import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Kalshi credentials, kept out of settings.json and encrypted at rest.
 *
 * The RSA private key can sign live orders, so it must not sit in a plain JSON
 * file that any script, sync client, or backup tool can read. On Windows
 * safeStorage wraps DPAPI, which ties the ciphertext to the logged-in Windows
 * account: copying credentials.dat to another machine or another user profile
 * yields nothing.
 *
 * The key is also never sent back to the renderer. The UI writes it and can
 * clear it, but only ever reads a status summary — see credentialStatus().
 */

export interface Credentials {
  apiKeyId: string;
  apiPrivateKeyPem: string;
}

export interface CredentialStatus {
  configured: boolean;
  /** First and last few characters of the key id, enough to recognise it. */
  keyIdHint: string;
  /** False only if the OS refused to give us a key store. */
  encryptionAvailable: boolean;
  /** Set when a vault exists but could not be decrypted. */
  error: string | null;
}

const FILE = "credentials.dat";
const EMPTY: Credentials = { apiKeyId: "", apiPrivateKeyPem: "" };

interface Envelope {
  v: 1;
  enc: "dpapi";
  data: string; // base64 ciphertext
}

function vaultPath(): string {
  return path.join(app.getPath("userData"), FILE);
}

function legacyPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Cached so a decrypt failure isn't retried on every scan tick. */
let cache: Credentials | null = null;
let lastError: string | null = null;

export function loadCredentials(): Credentials {
  if (cache) return cache;
  lastError = null;

  const p = vaultPath();
  if (!fs.existsSync(p)) {
    cache = EMPTY;
    return cache;
  }

  try {
    const env = JSON.parse(fs.readFileSync(p, "utf-8").replace(/^﻿/, "")) as Envelope;
    if (env.v !== 1 || env.enc !== "dpapi" || typeof env.data !== "string") {
      throw new Error("unrecognised vault format");
    }
    const plain = safeStorage.decryptString(Buffer.from(env.data, "base64"));
    const c = JSON.parse(plain) as Credentials;
    cache = {
      apiKeyId: String(c.apiKeyId ?? ""),
      apiPrivateKeyPem: String(c.apiPrivateKeyPem ?? ""),
    };
    return cache;
  } catch (e) {
    // A Windows profile change or a restored-from-backup file decrypts to
    // nothing. Say so rather than silently paper-trading a live setup.
    lastError =
      `Saved credentials could not be read on this Windows account. ` +
      `Re-enter your Kalshi key to fix it. (${(e as Error).message})`;
    cache = EMPTY;
    return cache;
  }
}

export function saveCredentials(c: Credentials): void {
  const next: Credentials = {
    apiKeyId: c.apiKeyId.trim(),
    apiPrivateKeyPem: c.apiPrivateKeyPem.trim(),
  };

  if (next.apiKeyId === "" && next.apiPrivateKeyPem === "") {
    clearCredentials();
    return;
  }

  if (!encryptionAvailable()) {
    throw new Error(
      "Windows would not provide a credential store, so the key cannot be saved securely. " +
        "Saving it in plain text is not an option this app offers.",
    );
  }

  const env: Envelope = {
    v: 1,
    enc: "dpapi",
    data: safeStorage.encryptString(JSON.stringify(next)).toString("base64"),
  };

  try {
    fs.writeFileSync(vaultPath(), JSON.stringify(env), { mode: 0o600 });
  } catch (e) {
    throw new Error(
      `Could not save credentials to ${app.getPath("userData")}: ${(e as Error).message}`,
    );
  }

  cache = next;
  lastError = null;
}

export function clearCredentials(): void {
  try {
    const p = vaultPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // a locked file shouldn't leave the app thinking keys are still set
  }
  // Drop the cache rather than parking EMPTY in it. Caching a blank result
  // would stop the vault ever re-reading disk, so a file that reappears — or
  // one that is present but undecryptable — would look identical to no file
  // at all, and the user would never be told their key stopped working.
  cache = null;
  lastError = null;
}

export function credentialStatus(): CredentialStatus {
  const c = loadCredentials();
  const id = c.apiKeyId;
  return {
    configured: id !== "" && c.apiPrivateKeyPem !== "",
    keyIdHint: id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id,
    encryptionAvailable: encryptionAvailable(),
    error: lastError,
  };
}

/**
 * Moves credentials written by 1.1.1 and earlier out of settings.json.
 *
 * Returns true when something was migrated. The old plaintext is overwritten
 * once before the file is rewritten; that is best-effort only, since a
 * journaling filesystem may still hold the original bytes elsewhere.
 */
export function migrateLegacyCredentials(): boolean {
  const p = legacyPath();
  if (!fs.existsSync(p)) return false;

  let raw: string;
  let parsed: Record<string, unknown>;
  try {
    raw = fs.readFileSync(p, "utf-8").replace(/^﻿/, "");
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false;
  }

  const id = typeof parsed.apiKeyId === "string" ? parsed.apiKeyId : "";
  const pem = typeof parsed.apiPrivateKeyPem === "string" ? parsed.apiPrivateKeyPem : "";
  const present = "apiKeyId" in parsed || "apiPrivateKeyPem" in parsed;
  if (!present) return false;

  // Only carry over a key that is actually usable; a half-filled pair is noise.
  if (id.trim() !== "" && pem.trim() !== "") {
    try {
      saveCredentials({ apiKeyId: id, apiPrivateKeyPem: pem });
    } catch {
      // If the vault won't take it, leave settings.json alone rather than
      // deleting the only copy of the user's key.
      return false;
    }
  }

  delete parsed.apiKeyId;
  delete parsed.apiPrivateKeyPem;

  try {
    fs.writeFileSync(p, "0".repeat(raw.length), "utf-8");
    fs.writeFileSync(p, JSON.stringify(parsed, null, 2), "utf-8");
  } catch {
    return false;
  }
  return true;
}
