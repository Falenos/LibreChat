export class ExecutionSemaphore {
  private active = 0;

  constructor(private readonly limit: number) {}

  tryAcquire(): (() => void) | null {
    if (this.active >= this.limit) {
      return null;
    }
    this.active += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active -= 1;
      }
    };
  }
}
