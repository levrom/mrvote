import { randomId, randomToken, sealJson, openJson, toVerificationCode, validateSelection } from "./core";
import { ballotFromSelection, hashCodeInput, hashIp, parseBallotJson } from "./repo";
import type { BallotRepository, ElectionWithOptions, ProtocolResult, VoteRecord, Env } from "./repo";

export interface BallotTicket {
  electionId: string;
  codeHash: string;
  expiresAt: number;
}

export interface VotePreparation {
  election: ElectionWithOptions;
  ticket: string;
}

export async function prepareBallot(repo: BallotRepository, env: Env, electionId: string, rawCode: string): Promise<{ ok: true; data: VotePreparation } | { ok: false; message: string; status: number }> {
  const election = await repo.getElectionWithOptions(electionId);
  if (!election) {
    return { ok: false, status: 404, message: "Голосование не найдено." };
  }
  if (election.status !== "active") {
    return { ok: false, status: 409, message: "Голосование сейчас не активно." };
  }

  const codeHash = await hashCodeInput(rawCode, env.CODE_SALT);
  const codeRow = await repo.findAccessCode(electionId, codeHash);
  if (!codeRow || codeRow.status !== "available") {
    return { ok: false, status: 403, message: "Код доступа неверный или уже использован." };
  }

  const ticketPayload: BallotTicket = {
    electionId,
    codeHash,
    expiresAt: Date.now() + 15 * 60 * 1000,
  };

  return {
    ok: true,
    data: {
      election,
      ticket: await sealJson(ticketPayload, env.APP_SECRET),
    },
  };
}

export async function submitBallot(repo: BallotRepository, env: Env, ticketToken: string, electionId: string, selectedOptionIds: string[], allowedOptionIds: string[]): Promise<{ ok: true; verificationCode: string } | { ok: false; message: string; status: number }> {
  const ticket = await openJson<BallotTicket>(ticketToken, env.APP_SECRET);
  if (!ticket) {
    return { ok: false, status: 403, message: "Сеанс голосования не найден. Введите код доступа заново." };
  }
  if (ticket.expiresAt < Date.now()) {
    return { ok: false, status: 403, message: "Временный доступ истёк. Введите код доступа заново." };
  }
  if (ticket.electionId !== electionId) {
    return { ok: false, status: 400, message: "Токен относится к другому голосованию." };
  }

  const election = await repo.getElectionWithOptions(electionId);
  if (!election || election.status !== "active") {
    return { ok: false, status: 409, message: "Голосование не активно." };
  }

  const selection = validateSelection(selectedOptionIds, allowedOptionIds, election.type, election.max_selections);
  if (!selection.ok) {
    return { ok: false, status: 400, message: selection.message };
  }

  const verificationCode = await generateVerificationCode();
  const success = await repo.claimAccessCodeAndCreateVote({
    electionId,
    codeHash: ticket.codeHash,
    ballotJson: ballotFromSelection(selection.normalized),
    verificationCode,
    flowMarker: randomId("flow_"),
  });

  if (!success) {
    return { ok: false, status: 409, message: "Код доступа уже был использован или голосование закрыто." };
  }

  return { ok: true, verificationCode };
}

export async function verifyByCode(repo: BallotRepository, electionId: string, verificationCode: string): Promise<{ ok: true; vote: VoteRecord } | { ok: false; message: string; status: number }> {
  const vote = await repo.findVoteByVerificationCode(electionId, verificationCode);
  if (!vote) {
    return { ok: false, status: 404, message: "Бюллетень не найден." };
  }
  return { ok: true, vote };
}

export async function generateVerificationCode(): Promise<string> {
  const parts = randomToken(9).toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
  return toVerificationCode(parts);
}

export function summarizeProtocol(election: ElectionWithOptions, votes: VoteRecord[], totalCodes: number, usedCodes: number): ProtocolResult {
  const optionMap = new Map(election.options.map((option) => [option.id, option]));
  const results = election.options.map((option) => ({ optionId: option.id, label: option.label, votes: 0, sortOrder: option.sort_order }));
  const entries = votes.map((vote) => {
    const selectedOptionIds: string[] = parseBallotJson(vote.ballot_json);
    const selectedOptions = selectedOptionIds.map((optionId: string) => optionMap.get(optionId)?.label ?? optionId);
    for (const optionId of selectedOptionIds) {
      const row = results.find((item) => item.optionId === optionId);
      if (row) {
        row.votes += 1;
      }
    }
    return {
      verificationCode: vote.verification_code,
      selectedOptionIds,
      selectedOptions,
    };
  });

  return {
    election: election,
    options: election.options.map((option) => ({ id: option.id, label: option.label, sort_order: option.sort_order })),
    totalCodes,
    usedCodes,
    totalVotes: votes.length,
    results: results.sort((a, b) => b.votes - a.votes || a.sortOrder - b.sortOrder),
    entries,
  };
}

export async function rateLimitAttempt(repo: BallotRepository, env: Env, scope: string, requestIp: string): Promise<{ allowed: boolean; attempts: number }> {
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const ipHash = await hashIp(requestIp, env.CODE_SALT);
  const attempts = await repo.recordAttempt(scope, ipHash, minuteBucket);
  return { allowed: attempts <= 10, attempts };
}
