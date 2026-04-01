import { TaskCoordinatorDO } from "../../src/durable/TaskCoordinatorDO";
import {
  DurableObjectNamespaceLike,
  DurableObjectStateLike,
  DurableObjectStorageLike,
  DurableObjectStubLike,
  Env,
  R2BucketLike,
  R2GetObjectLike,
  R2ObjectLike,
} from "../../src/lib/types";

class InMemoryR2Object implements R2GetObjectLike {
  private readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  async json<T>(): Promise<T> {
    return JSON.parse(this.value) as T;
  }
}

export class InMemoryR2Bucket implements R2BucketLike {
  private readonly data = new Map<string, string>();

  async put(
    key: string,
    value: string | ArrayBuffer | Uint8Array
  ): Promise<void> {
    if (typeof value === "string") {
      this.data.set(key, value);
      return;
    }

    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
    this.data.set(key, new TextDecoder().decode(bytes));
  }

  async get(key: string): Promise<R2GetObjectLike | null> {
    const value = this.data.get(key);
    return value === undefined ? null : new InMemoryR2Object(value);
  }

  async list(options?: { prefix?: string }): Promise<{ objects: R2ObjectLike[] }> {
    const prefix = options?.prefix ?? "";
    const objects = Array.from(this.data.keys())
      .filter((key) => key.startsWith(prefix))
      .sort()
      .map((key) => ({ key }));
    return { objects };
  }
}

class InMemoryDOStorage implements DurableObjectStorageLike {
  private readonly storage = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.storage.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.storage.set(key, value);
  }
}

function toRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  if (input instanceof Request) return input;
  return new Request(input, init);
}

function createTaskCoordinatorNamespace(): DurableObjectNamespaceLike {
  const instances = new Map<string, { object: TaskCoordinatorDO; state: DurableObjectStateLike }>();

  return {
    idFromName(name: string): unknown {
      return name;
    },

    get(id: unknown): DurableObjectStubLike {
      const key = String(id);
      let entry = instances.get(key);
      if (!entry) {
        const state: DurableObjectStateLike = { storage: new InMemoryDOStorage() };
        entry = { object: new TaskCoordinatorDO(state, {}), state };
        instances.set(key, entry);
      }

      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          return entry!.object.fetch(toRequest(input, init));
        },
      };
    },
  };
}

/**
 * Minimal deterministic env used by unit/integration tests.
 *
 * Expand later:
 * - attach AI gateway stub behavior
 * - add failure injection toggles for R2/DO operations
 */
export function createMockEnv(): Env {
  return {
    TASK_COORDINATOR: createTaskCoordinatorNamespace(),
    R2_WORKLOGS: new InMemoryR2Bucket(),
    R2_ARTIFACTS: new InMemoryR2Bucket(),
  };
}
