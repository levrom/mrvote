import { summarizeProtocol, generateVerificationCode, prepareBallot, rateLimitAttempt, submitBallot } from "../src/lib/service";
import type { BallotRepository, ElectionWithOptions, VoteRecord } from "../src/lib/repo";

function buildElection(status: "draft" | "active" | "stopped" | "closed" = "active"): ElectionWithOptions {
  return {
    id: "election-1",
    title: "Выбор председателя",
    description: "",
    type: "single",
    max_selections: 1,
    status,
    start_at: null,
    end_at: null,
    created_at: "2026-06-17T00:00:00.000Z",
    options: [
      { id: "opt-a", election_id: "election-1", label: "Иванов", sort_order: 1, active: 1 },
      { id: "opt-b", election_id: "election-1", label: "Петров", sort_order: 2, active: 1 },
    ],
  };
}

function createRepo(overrides: Partial<BallotRepository> & Record<string, unknown> = {}): BallotRepository {
  const repo: BallotRepository = {
    listElections: async () => [],
    getElectionWithOptions: async () => buildElection(),
    createElection: async () => "election-1",
    replaceElectionOptions: async () => undefined,
    setElectionStatus: async () => undefined,
    countAccessCodes: async () => ({ total: 2, used: 0 }),
    createAccessCodes: async () => undefined,
    findAccessCode: async () => ({ id: "code-1", election_id: "election-1", code_hash: "hash", status: "available", issued_batch_id: "batch-1" }),
    claimAccessCodeAndCreateVote: async () => true,
    findVoteByVerificationCode: async () => ({ id: "vote-1", election_id: "election-1", ballot_json: JSON.stringify({ selectedOptionIds: ["opt-a"] }), verification_code: "VERI-FY12", flow_marker: "flow-1" }),
    listVotesForProtocol: async () => [
      { id: "vote-1", election_id: "election-1", ballot_json: JSON.stringify({ selectedOptionIds: ["opt-a"] }), verification_code: "VERI-FY12", flow_marker: "flow-1" },
      { id: "vote-2", election_id: "election-1", ballot_json: JSON.stringify({ selectedOptionIds: ["opt-b"] }), verification_code: "VERI-FY34", flow_marker: "flow-2" },
    ],
    recordAttempt: async () => 1,
    ...overrides,
  };
  return repo;
}

const env = {
  ADMIN_PASSWORD: "secret",
  APP_SECRET: "app-secret",
  CODE_SALT: "code-salt",
  DB: {} as D1Database,
};

describe("vote service", () => {
  it("prepares a ballot ticket for a valid code", async () => {
    const result = await prepareBallot(createRepo(), env, "election-1", "A9K2-M7QP");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.ticket).toBeTruthy();
      expect(result.data.election.id).toBe("election-1");
    }
  });

  it("rejects inactive elections", async () => {
    const result = await prepareBallot(createRepo({ getElectionWithOptions: async () => buildElection("stopped") }), env, "election-1", "A9K2-M7QP");
    expect(result.ok).toBe(false);
  });

  it("submits a ballot and returns a verification code", async () => {
    const ticket = await (await import("../src/lib/core")).sealJson({ electionId: "election-1", codeHash: "hash", expiresAt: Date.now() + 60_000 }, env.APP_SECRET);
    const result = await submitBallot(createRepo(), env, ticket, "election-1", ["opt-a"], ["opt-a", "opt-b"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verificationCode).toMatch(/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}$/);
    }
  });

  it("summarizes protocol entries", () => {
    const protocol = summarizeProtocol(buildElection(), [
      { id: "vote-1", election_id: "election-1", ballot_json: JSON.stringify({ selectedOptionIds: ["opt-a"] }), verification_code: "VERI-FY12", flow_marker: "flow-1" },
      { id: "vote-2", election_id: "election-1", ballot_json: JSON.stringify({ selectedOptionIds: ["opt-b"] }), verification_code: "VERI-FY34", flow_marker: "flow-2" },
    ], 2, 2);
    expect(protocol.totalVotes).toBe(2);
    expect(protocol.results[0].votes).toBe(1);
  });

  it("blocks home password brute force after three attempts", async () => {
    const result = await rateLimitAttempt(
      createRepo({
        recordAttempt: async () => 4,
      }),
      env,
      "home-password",
      "203.0.113.10",
      { limit: 3, windowMs: 24 * 60 * 60 * 1000 },
    );
    expect(result.allowed).toBe(false);
    expect(result.attempts).toBe(4);
  });

  it("blocks admin password brute force after three attempts", async () => {
    const result = await rateLimitAttempt(
      createRepo({
        recordAttempt: async () => 4,
      }),
      env,
      "admin-password",
      "203.0.113.11",
      { limit: 3, windowMs: 24 * 60 * 60 * 1000 },
    );
    expect(result.allowed).toBe(false);
    expect(result.attempts).toBe(4);
  });
});
