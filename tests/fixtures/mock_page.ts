// Mock page interface for exercising executeStep without launching Firefox.

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export class MockMouse {
  calls: RecordedCall[] = [];
  async wheel(x: number, y: number): Promise<void> {
    this.calls.push({ method: "mouse.wheel", args: [x, y] });
  }
}

export class MockLocator {
  calls: RecordedCall[] = [];
  constructor(public selector: string, public page: MockPage) {}
  async click(): Promise<void> { this.calls.push({ method: "click", args: [] }); }
  async fill(value: string): Promise<void> { this.calls.push({ method: "fill", args: [value] }); }
  async waitFor(opts: unknown): Promise<void> {
    this.calls.push({ method: "waitFor", args: [opts] });
  }
}

export class MockPage {
  calls: RecordedCall[] = [];
  mouse = new MockMouse();
  private waitTimeoutMs = 0;
  private locators = new Map<string, MockLocator>();

  locator(selector: string): MockLocator {
    let loc = this.locators.get(selector);
    if (!loc) {
      loc = new MockLocator(selector, this);
      this.locators.set(selector, loc);
    }
    return loc;
  }
  async goto(url: string): Promise<void> { this.calls.push({ method: "goto", args: [url] }); }
  async waitForLoadState(state: string): Promise<void> {
    this.calls.push({ method: "waitForLoadState", args: [state] });
  }
  async waitForTimeout(ms: number): Promise<void> {
    this.waitTimeoutMs += ms;
    this.calls.push({ method: "waitForTimeout", args: [ms] });
  }
  async evaluate(expr: string): Promise<void> {
    this.calls.push({ method: "evaluate", args: [expr] });
  }
  totalWaitMs(): number { return this.waitTimeoutMs; }
}
