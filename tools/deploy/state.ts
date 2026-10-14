import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const outcomeSchema = z.enum(["passed", "failed", "blocked", "dry-run"]);
const attemptSchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  startedAt: z.string(),
  outcome: outcomeSchema.optional(),
  evidence: z.string().optional(),
  investigationThread: z.string().optional(),
});
const stateSchema = z.object({
  notifications: z.record(z.string(), z.boolean()),
  attempts: z.array(attemptSchema),
});

/** Recorded verification result; blocked authentication is not a passing deployment. */
export type Outcome = z.infer<typeof outcomeSchema>;
/** One claimed commit and its optional final verification evidence. */
export type Attempt = z.infer<typeof attemptSchema>;
type State = z.infer<typeof stateSchema>;

/** Single-owner-orb persistence; atomic replacement does not support shared-directory writers. */
export class DeploymentState {
  /** Uses the owning orb's private directory; does not create it until the first write. */
  constructor(private readonly directory: string) {}

  /** Returns empty state only for a missing file; corrupt persisted state fails closed. */
  read(): State {
    try {
      return stateSchema.parse(JSON.parse(readFileSync(join(this.directory, "state.json"), "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return { notifications: {}, attempts: [] };
    }
  }

  private write(state: State): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, "state.json.tmp");
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, join(this.directory, "state.json"));
  }

  /** Persists delivery after waking; interruption may redeliver, so next() deduplicates claims. */
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

  /** Resumes active work first; a completed commit needs an explicitly reviewed retry. */
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

  /** Finalizes only the active claim, requiring evidence and a failure investigation thread. */
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
