/**
 * Chapter 00 shared base: EventStream (producer-consumer decoupling via an event queue + waiting consumers).
 *
 * Matches all the semantics of Pi's `EventStream` (pi-ai utils/event-stream.ts, 88 lines in total including AssistantMessageEventStream;
 * the teaching counterpart is the plain EventStream class, L4-67):
 * - queue + waiting (L5-6/L29-35): producer faster than consumer → queue up; consumer faster than producer → suspend and wait (no events dropped)
 * - AsyncIterable (L50-62): consumed with `for await`
 * - `isComplete`/`extractResult` constructor parameters (L13-19): end signal and result extraction
 * - `push` completes automatically when it hits the end signal (L24-27); `end(result)` ends explicitly (L38-48); `result()` (L64-66)
 */
export class EventStream<TEvent, TResult> implements AsyncIterable<TEvent> {
  private queue: TEvent[] = [];
  private waiting: ((value: IteratorResult<TEvent>) => void)[] = [];
  private done = false;
  private finalResultPromise: Promise<TResult>;
  private resolveFinalResult!: (result: TResult) => void;
  private isComplete: (event: TEvent) => boolean;
  private extractResult: (event: TEvent) => TResult;

  constructor(isComplete: (event: TEvent) => boolean, extractResult: (event: TEvent) => TResult) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: TEvent): void {
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  end(result?: TResult): void {
    this.done = true;
    if (result !== undefined) {
      this.resolveFinalResult(result);
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TEvent> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<TEvent>>((resolve) => this.waiting.push(resolve));
        if (result.done) return;
        yield result.value;
      }
    }
  }

  result(): Promise<TResult> {
    return this.finalResultPromise;
  }
}
