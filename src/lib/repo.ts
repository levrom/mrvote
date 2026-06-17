import { generateHumanCode, normalizeCodeInput, nowIso, parseJsonArray, randomId, safeJson, sha256Hex, toDisplayCode } from "./core";

export type ElectionType = "single" | "multiple";
export type ElectionStatus = "draft" | "active" | "stopped" | "closed";

export interface Env {
  DB: D1Database;
  ADMIN_PASSWORD: string;
  APP_SECRET: string;
  CODE_SALT: string;
  HOME_PASSWORD?: string;
}

export interface ElectionRecord {
  id: string;
  title: string;
  description: string;
  type: ElectionType;
  max_selections: number | null;
  status: ElectionStatus;
  start_at: string | null;
  end_at: string | null;
  created_at: string;
}

export interface ElectionOptionRecord {
  id: string;
  election_id: string;
  label: string;
  sort_order: number;
  active: number;
}

export interface ElectionWithOptions extends ElectionRecord {
  options: ElectionOptionRecord[];
}

export interface ElectionListItem extends ElectionRecord {
  total_codes: number;
  used_codes: number;
  total_votes: number;
}

export interface VoteRecord {
  id: string;
  election_id: string;
  ballot_json: string;
  verification_code: string;
  flow_marker: string;
}

export interface VoteProtocolEntry {
  verification_code: string;
  ballot_json: string;
}

export interface ProtocolResult {
  election: ElectionRecord;
  options: Array<{ id: string; label: string; sort_order: number }>;
  totalCodes: number;
  usedCodes: number;
  totalVotes: number;
  results: Array<{ optionId: string; label: string; votes: number; sortOrder: number }>;
  entries: Array<{ verificationCode: string; selectedOptionIds: string[]; selectedOptions: string[] }>;
}

export interface AccessCodeRow {
  id: string;
  election_id: string;
  code_hash: string;
  status: "available" | "used" | "revoked";
  issued_batch_id: string;
}

export interface ClaimVoteInput {
  electionId: string;
  codeHash: string;
  ballotJson: string;
  verificationCode: string;
  flowMarker: string;
}

export interface BallotRepository {
  listElections(): Promise<ElectionListItem[]>;
  getElectionWithOptions(id: string): Promise<ElectionWithOptions | null>;
  createElection(input: Omit<ElectionRecord, "created_at" | "status"> & { status?: ElectionStatus }): Promise<string>;
  replaceElectionOptions(electionId: string, labels: string[]): Promise<void>;
  setElectionStatus(id: string, status: ElectionStatus): Promise<void>;
  countAccessCodes(electionId: string): Promise<{ total: number; used: number }>;
  createAccessCodes(electionId: string, codeHashes: string[], batchId: string): Promise<void>;
  findAccessCode(electionId: string, codeHash: string): Promise<AccessCodeRow | null>;
  claimAccessCodeAndCreateVote(input: ClaimVoteInput): Promise<boolean>;
  findVoteByVerificationCode(electionId: string, verificationCode: string): Promise<VoteRecord | null>;
  listVotesForProtocol(electionId: string): Promise<VoteRecord[]>;
  recordAttempt(scope: string, ipHash: string, timeBucket: number): Promise<number>;
}

export function splitOptionsFromText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function hashIp(ip: string, secret: string): Promise<string> {
  return sha256Hex(`${secret}:${ip}`);
}

export async function hashCodeInput(codeInput: string, codeSalt: string): Promise<string> {
  return sha256Hex(`${codeSalt}:${normalizeCodeInput(codeInput)}`);
}

export function ballotFromSelection(selectedOptionIds: string[]): string {
  return safeJson({ selectedOptionIds });
}

export function parseBallotJson(ballotJson: string): string[] {
  try {
    const parsed = JSON.parse(ballotJson) as { selectedOptionIds?: unknown };
    if (!parsed || !Array.isArray(parsed.selectedOptionIds)) return [];
    return parsed.selectedOptionIds.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export class D1BallotRepository implements BallotRepository {
  constructor(private readonly db: D1Database) {}

  async listElections(): Promise<ElectionListItem[]> {
    const { results } = await this.db
      .prepare(
        `
        SELECT
          e.id,
          e.title,
          e.description,
          e.type,
          e.max_selections,
          e.status,
          e.start_at,
          e.end_at,
          e.created_at,
          COALESCE((SELECT COUNT(*) FROM access_codes ac WHERE ac.election_id = e.id), 0) AS total_codes,
          COALESCE((SELECT COUNT(*) FROM access_codes ac WHERE ac.election_id = e.id AND ac.status = 'used'), 0) AS used_codes,
          COALESCE((SELECT COUNT(*) FROM votes v WHERE v.election_id = e.id), 0) AS total_votes
        FROM elections e
        ORDER BY e.created_at DESC
        `,
      )
      .all<ElectionListItem>();
    return results;
  }

  async getElectionWithOptions(id: string): Promise<ElectionWithOptions | null> {
    const election = await this.db
      .prepare(
        `
        SELECT id, title, description, type, max_selections, status, start_at, end_at, created_at
        FROM elections
        WHERE id = ?
        `,
      )
      .bind(id)
      .first<ElectionRecord>();
    if (!election) return null;
    const { results } = await this.db
      .prepare(
        `
        SELECT id, election_id, label, sort_order, active
        FROM election_options
        WHERE election_id = ?
        ORDER BY sort_order ASC, label ASC
        `,
      )
      .bind(id)
      .all<ElectionOptionRecord>();
    return { ...election, options: results };
  }

  async createElection(input: Omit<ElectionRecord, "created_at" | "status"> & { status?: ElectionStatus }): Promise<string> {
    const id = input.id ?? randomId("election_");
    await this.db
      .prepare(
        `
        INSERT INTO elections (id, title, description, type, max_selections, status, start_at, end_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .bind(
        id,
        input.title,
        input.description,
        input.type,
        input.max_selections,
        input.status ?? "draft",
        input.start_at,
        input.end_at,
      )
      .run();
    return id;
  }

  async replaceElectionOptions(electionId: string, labels: string[]): Promise<void> {
    const writes = labels.map((label, index) =>
      this.db
        .prepare(
          `
          INSERT INTO election_options (id, election_id, label, sort_order, active)
          VALUES (?, ?, ?, ?, 1)
          `,
        )
        .bind(randomId("option_"), electionId, label, index + 1),
    );
    await this.db.batch([
      this.db.prepare(`DELETE FROM election_options WHERE election_id = ?`).bind(electionId),
      ...writes,
    ]);
  }

  async setElectionStatus(id: string, status: ElectionStatus): Promise<void> {
    await this.db
      .prepare(
        `
        UPDATE elections
        SET status = ?
        WHERE id = ?
        `,
      )
      .bind(status, id)
      .run();
  }

  async countAccessCodes(electionId: string): Promise<{ total: number; used: number }> {
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) AS value FROM access_codes WHERE election_id = ?`)
      .bind(electionId)
      .first<{ value: number }>();
    const usedRow = await this.db
      .prepare(`SELECT COUNT(*) AS value FROM access_codes WHERE election_id = ? AND status = 'used'`)
      .bind(electionId)
      .first<{ value: number }>();
    return { total: totalRow?.value ?? 0, used: usedRow?.value ?? 0 };
  }

  async createAccessCodes(electionId: string, codeHashes: string[], batchId: string): Promise<void> {
    const statements = codeHashes.map((codeHash) =>
      this.db
        .prepare(
          `
          INSERT INTO access_codes (id, election_id, code_hash, status, issued_batch_id)
          VALUES (?, ?, ?, 'available', ?)
          `,
        )
        .bind(randomId("code_"), electionId, codeHash, batchId),
    );
    await this.db.batch(statements);
  }

  async findAccessCode(electionId: string, codeHash: string): Promise<AccessCodeRow | null> {
    return await this.db
      .prepare(
        `
        SELECT id, election_id, code_hash, status, issued_batch_id
        FROM access_codes
        WHERE election_id = ? AND code_hash = ?
        `,
      )
      .bind(electionId, codeHash)
      .first<AccessCodeRow>();
  }

  async claimAccessCodeAndCreateVote(input: ClaimVoteInput): Promise<boolean> {
    const result = await this.db.batch([
      this.db
        .prepare(
          `
          UPDATE access_codes
          SET status = 'used'
          WHERE election_id = ?
            AND code_hash = ?
            AND status = 'available'
            AND EXISTS (
              SELECT 1
              FROM elections
              WHERE id = ? AND status = 'active'
            )
          `,
        )
        .bind(input.electionId, input.codeHash, input.electionId),
      this.db
        .prepare(
          `
          INSERT INTO votes (id, election_id, ballot_json, verification_code, flow_marker)
          SELECT ?, ?, ?, ?, ?
          WHERE changes() = 1
          `,
        )
        .bind(randomId("vote_"), input.electionId, input.ballotJson, input.verificationCode, input.flowMarker),
    ]);

    return Boolean(result[1]?.success && (result[1].meta?.changes ?? 0) === 1);
  }

  async findVoteByVerificationCode(electionId: string, verificationCode: string): Promise<VoteRecord | null> {
    return await this.db
      .prepare(
        `
        SELECT id, election_id, ballot_json, verification_code, flow_marker
        FROM votes
        WHERE election_id = ? AND verification_code = ?
        `,
      )
      .bind(electionId, verificationCode)
      .first<VoteRecord>();
  }

  async listVotesForProtocol(electionId: string): Promise<VoteRecord[]> {
    const { results } = await this.db
      .prepare(
        `
        SELECT id, election_id, ballot_json, verification_code, flow_marker
        FROM votes
        WHERE election_id = ?
        ORDER BY verification_code ASC
        `,
      )
      .bind(electionId)
      .all<VoteRecord>();
    return results;
  }

  async recordAttempt(scope: string, ipHash: string, timeBucket: number): Promise<number> {
    await this.db
      .prepare(
        `
        INSERT INTO attempt_windows (scope, ip_hash, time_bucket, attempts)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(scope, ip_hash, time_bucket)
        DO UPDATE SET attempts = attempts + 1
        `,
      )
      .bind(scope, ipHash, timeBucket)
      .run();
    const row = await this.db
      .prepare(
        `
        SELECT attempts
        FROM attempt_windows
        WHERE scope = ? AND ip_hash = ? AND time_bucket = ?
        `,
      )
      .bind(scope, ipHash, timeBucket)
      .first<{ attempts: number }>();
    return row?.attempts ?? 0;
  }
}
