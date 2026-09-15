export interface RunCountSnapshot {
  queueDepth: number;
  activeRuns: number;
}

export interface RunCounts {
  snapshot(): RunCountSnapshot;
  started(): void;
  finished(): void;
}

export class InMemoryRunCounts implements RunCounts {
  private activeRuns = 0;

  snapshot(): RunCountSnapshot {
    return { queueDepth: 0, activeRuns: this.activeRuns };
  }

  started(): void {
    this.activeRuns += 1;
  }

  finished(): void {
    this.activeRuns = Math.max(0, this.activeRuns - 1);
  }
}
