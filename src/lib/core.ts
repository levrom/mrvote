const ACCESS_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bufferToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomId(prefix = ""): string {
  return `${prefix}${crypto.randomUUID()}`;
}

export function randomToken(byteLength = 18): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function generateHumanCode(groups = 3, groupLength = 4): string {
  const totalLength = groups * groupLength;
  const bytes = new Uint8Array(totalLength);
  crypto.getRandomValues(bytes);
  let raw = "";
  for (let i = 0; i < totalLength; i += 1) {
    raw += ACCESS_CODE_ALPHABET[bytes[i] % ACCESS_CODE_ALPHABET.length];
  }
  return Array.from({ length: groups }, (_, index) => raw.slice(index * groupLength, (index + 1) * groupLength)).join("-");
}

export function normalizeCodeInput(value: string): string {
  return value.replaceAll(/\s+/g, "").replaceAll("-", "").toUpperCase();
}

export function normalizeVoteSelection(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

export function isAllowedSelectionCount(type: "single" | "multiple", maxSelections: number | null, selectedCount: number): boolean {
  if (type === "single") {
    return selectedCount === 1;
  }
  if (!maxSelections || maxSelections < 1) {
    return selectedCount >= 1;
  }
  return selectedCount >= 1 && selectedCount <= maxSelections;
}

export function validateSelection(selectedOptionIds: string[], allowedOptionIds: string[], type: "single" | "multiple", maxSelections: number | null): { ok: true; normalized: string[] } | { ok: false; message: string } {
  const unique = new Set<string>();
  const normalized = normalizeVoteSelection(selectedOptionIds);
  for (const id of normalized) {
    if (unique.has(id)) {
      return { ok: false, message: "Нельзя выбрать один и тот же вариант дважды." };
    }
    unique.add(id);
  }

  if (!isAllowedSelectionCount(type, maxSelections, unique.size)) {
    if (type === "single") {
      return { ok: false, message: "Нужно выбрать ровно один вариант." };
    }
    return { ok: false, message: `Можно выбрать не более ${maxSelections ?? 0} вариантов.` };
  }

  const allowed = new Set(allowedOptionIds);
  for (const id of unique) {
    if (!allowed.has(id)) {
      return { ok: false, message: "Выбран неизвестный вариант." };
    }
  }

  return { ok: true, normalized: [...unique] };
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(input));
  return bufferToHex(digest);
}

export async function hashAccessCode(codeInput: string, codeSalt: string): Promise<string> {
  return sha256Hex(`${codeSalt}:${normalizeCodeInput(codeInput)}`);
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", textEncoder.encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealJson<T>(payload: T, secret: string): Promise<string> {
  const key = await deriveAesKey(secret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const data = textEncoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext as ArrayBuffer))}`;
}

export async function openJson<T>(token: string, secret: string): Promise<T | null> {
  const [ivPart, cipherPart] = token.split(".");
  if (!ivPart || !cipherPart) {
    return null;
  }
  try {
    const key = await deriveAesKey(secret);
    const iv = fromBase64Url(ivPart) as unknown as Uint8Array<ArrayBuffer>;
    const cipherBytes = fromBase64Url(cipherPart) as unknown as Uint8Array<ArrayBuffer>;
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes);
    return JSON.parse(textDecoder.decode(plaintext)) as T;
  } catch {
    return null;
  }
}

export function toDisplayCode(value: string): string {
  const normalized = normalizeCodeInput(value);
  return normalized.match(/.{1,4}/g)?.join("-") ?? normalized;
}

export function toVerificationCode(raw: string): string {
  const normalized = raw.replaceAll(/[^A-Z0-9]/g, "").toUpperCase();
  return normalized.slice(0, 12).padEnd(12, "A").match(/.{1,4}/g)?.join("-") ?? normalized;
}

export function safeJson<T>(value: T): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

export function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item === "string");
  } catch {
    return [];
  }
}
