import assert from "node:assert";
import {
  afterEach as nodeAfterEach,
  describe as nodeDescribe,
  it as nodeIt,
  test as nodeTest,
} from "node:test";

export const afterEach = nodeAfterEach;
export const describe = nodeDescribe;
export const it = nodeIt;
export const test = nodeTest;

type Constructor = new (...args: never[]) => unknown;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const deepEqual = (actual: unknown, expected: unknown): boolean => {
  try {
    assert.deepStrictEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
};

const matchesObject = (actual: unknown, expected: unknown): boolean => {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length <= actual.length &&
      expected.every((item, index) => matchesObject(actual[index], item))
    );
  }

  if (expected instanceof Date) {
    return actual instanceof Date && actual.getTime() === expected.getTime();
  }

  if (isRecord(expected)) {
    return (
      isRecord(actual) &&
      Object.entries(expected).every(([key, item]) =>
        matchesObject(actual[key], item)
      )
    );
  }

  return deepEqual(actual, expected);
};

const contains = (actual: unknown, expected: unknown): boolean => {
  if (typeof actual === "string") return actual.includes(String(expected));

  if (Array.isArray(actual)) {
    return actual.some((item) => deepEqual(item, expected));
  }

  return false;
};

const errorMatches = (error: unknown, expected: unknown): boolean => {
  if (expected === undefined) return error !== undefined;

  if (typeof expected === "string") {
    return error instanceof Error && error.message.includes(expected);
  }

  if (expected instanceof RegExp) {
    return error instanceof Error && expected.test(error.message);
  }

  if (typeof expected === "function") {
    return error instanceof (expected as Constructor);
  }

  if (expected instanceof Error) {
    return error instanceof Error && error.message === expected.message;
  }

  return deepEqual(error, expected);
};

class Expectation {
  readonly actual: unknown;
  readonly inverted: boolean;

  constructor(actual: unknown, inverted = false) {
    this.actual = actual;
    this.inverted = inverted;
  }

  get not(): Expectation {
    return new Expectation(this.actual, !this.inverted);
  }

  get rejects(): {
    toBe: (expected: unknown) => Promise<void>;
    toBeInstanceOf: (expected: Constructor) => Promise<void>;
    toEqual: (expected: unknown) => Promise<void>;
    toMatchObject: (expected: unknown) => Promise<void>;
    toThrow: (expected?: unknown) => Promise<void>;
  } {
    const capture = async (): Promise<unknown> => {
      try {
        await this.actual;
      } catch (error) {
        return error;
      }

      throw new assert.AssertionError({
        message: "Expected promise to reject, but it resolved.",
      });
    };

    return {
      toBe: async (expected: unknown) => {
        assert.strictEqual(await capture(), expected);
      },
      toBeInstanceOf: async (expected: Constructor) => {
        assert.ok((await capture()) instanceof expected);
      },
      toEqual: async (expected: unknown) => {
        assert.deepStrictEqual(await capture(), expected);
      },
      toMatchObject: async (expected: unknown) => {
        assert.ok(matchesObject(await capture(), expected));
      },
      toThrow: async (expected?: unknown) => {
        assert.ok(errorMatches(await capture(), expected));
      },
    };
  }

  check(pass: boolean, message: string): void {
    if (pass === this.inverted) {
      throw new assert.AssertionError({ message });
    }
  }

  toBe(expected: unknown): void {
    this.check(Object.is(this.actual, expected), "Expected values to be identical.");
  }

  toEqual(expected: unknown): void {
    this.check(deepEqual(this.actual, expected), "Expected values to be deeply equal.");
  }

  toContain(expected: unknown): void {
    this.check(contains(this.actual, expected), "Expected value to contain the expected item.");
  }

  toMatchObject(expected: unknown): void {
    this.check(matchesObject(this.actual, expected), "Expected value to match the expected object.");
  }

  toHaveLength(expected: number): void {
    const length =
      typeof this.actual === "string" || Array.isArray(this.actual)
        ? this.actual.length
        : undefined;

    this.check(length === expected, "Expected value to have the expected length.");
  }

  toBeInstanceOf(expected: Constructor): void {
    this.check(this.actual instanceof expected, "Expected value to be an instance of the expected class.");
  }

  toBeUndefined(): void {
    this.check(this.actual === undefined, "Expected value to be undefined.");
  }

  toBeNull(): void {
    this.check(this.actual === null, "Expected value to be null.");
  }

  toEndWith(expected: string): void {
    this.check(
      typeof this.actual === "string" && this.actual.endsWith(expected),
      "Expected string to end with the expected suffix."
    );
  }

  toThrow(expected?: unknown): void {
    if (typeof this.actual !== "function") {
      throw new assert.AssertionError({ message: "Expected a function that throws." });
    }

    let thrown: unknown;

    try {
      (this.actual as () => unknown)();
    } catch (error) {
      thrown = error;
    }

    this.check(errorMatches(thrown, expected), "Expected function to throw the expected error.");
  }
}

export const expect = (actual: unknown): Expectation => new Expectation(actual);
