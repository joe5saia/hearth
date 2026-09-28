import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Outcome = "passed" | "failed" | "blocked" | "dry-run";
export type Attempt = {
  sha: string;
  startedAt: string;
  outcome?: Outcome;
  evidence?: string;
  investigationThread?: string;
};
type State = {
  notifications: Record<string, boolean>;
  attempts: Attempt[];
};

// One owning orb is the only writer. Synchronous atomic replacement prevents
// interleaved webhook/tool calls from losing updates; never share this directory.
export class DeploymentState {
  constructor(private readonly directory: string) {}

  read(): State {
    try {
      return JSON.parse(readFileSync(join(this.directory, "state.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { notifications: {}, attempts: [] };
    }
  }

  private write(state: State): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, "state.json.tmp");
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, join(this.directory, "state.json"));
  }

  async notify(id: string, wake: () => Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const state = this.read();
    if (state.notifications[id] === true) return;
    state.notifications[id] = false;
    this.write(state);
    await wake();
    // If interrupted after append, redelivery may append twice. next() keeps
    // those messages from starting two deployments of the same commit.
    signal.throwIfAborted();
    const latest = this.read();
    latest.notifications[id] = true;
    this.write(latest);
  }

  next(sha: string, retryAfterReview = false): { attempt: Attempt; resume: boolean } | null {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid main commit SHA");
    const state = this.read();
    const active = state.attempts.find((attempt) => !attempt.outcome);
    if (active) return { attempt: active, resume: true };
    const previous = state.attempts.find((attempt) => attempt.sha === sha);
    if (previous && !retryAfterReview) return null;
    const attempt = { sha, startedAt: new Date().toISOString() };
    state.attempts.push(attempt);
    this.write(state);
    return { attempt, resume: previous !== undefined };
  }

  finish(sha: string, outcome: Outcome, evidence: string, investigationThread?: string): void {
    const state = this.read();
    const active = state.attempts.find((attempt) => !attempt.outcome);
    if (!active || active.sha !== sha) throw new Error("Commit does not own the active deployment");
    if (!evidence.trim()) throw new Error("Verification evidence is required");
    if (outcome === "failed" && !investigationThread) {
      throw new Error("A failed deployment requires an investigation thread");
    }
    Object.assign(active, { outcome, evidence, investigationThread });
    this.write(state);
  }
}
