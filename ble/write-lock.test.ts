import { test, expect, describe } from "bun:test";
import { withWriteLock, type WriteLockHolder } from "./ble";

function holder(): WriteLockHolder {
  return { writeLock: Promise.resolve() };
}

describe("withWriteLock", () => {
  test("runs fn and returns its value", async () => {
    const h = holder();
    const result = await withWriteLock(h, async () => 42);
    expect(result).toBe(42);
  });

  test("propagates errors and releases the lock", async () => {
    const h = holder();
    await expect(
      withWriteLock(h, async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");
    // lock is released — a subsequent call should succeed
    const ok = await withWriteLock(h, async () => "ok");
    expect(ok).toBe("ok");
  });

  test("serializes concurrent callers", async () => {
    const h = holder();
    const order: number[] = [];

    // Simulate two concurrent multi-step writes.
    // Without the lock, step interleaving would produce [1,2,1,2].
    // With the lock, we get [1,1,2,2].
    const a = withWriteLock(h, async () => {
      order.push(1);
      await Bun.sleep(10);
      order.push(1);
    });
    const b = withWriteLock(h, async () => {
      order.push(2);
      await Bun.sleep(10);
      order.push(2);
    });

    await Promise.all([a, b]);
    expect(order).toEqual([1, 1, 2, 2]);
  });

  test("many concurrent callers execute in order", async () => {
    const h = holder();
    const order: number[] = [];

    const tasks = Array.from({ length: 5 }, (_, i) =>
      withWriteLock(h, async () => {
        order.push(i);
        await Bun.sleep(1);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  test("simulates heartbeat vs REBUILD interleaving protection", async () => {
    // Models the real scenario: a multi-fragment REBUILD write (3 steps)
    // running concurrently with a single-fragment heartbeat.
    const h = holder();
    const wire: string[] = [];

    const rebuild = withWriteLock(h, async () => {
      wire.push("R1");
      await Bun.sleep(5);
      wire.push("R2");
      await Bun.sleep(5);
      wire.push("R3");
    });

    // Heartbeat fires 2ms into the rebuild's first fragment write
    await Bun.sleep(2);
    const heartbeat = withWriteLock(h, async () => {
      wire.push("HB");
    });

    await Promise.all([rebuild, heartbeat]);

    // Without the lock, HB would land between R1 and R2.
    // With the lock, HB waits until all rebuild fragments finish.
    expect(wire).toEqual(["R1", "R2", "R3", "HB"]);
  });

  test("lock released even on throw mid-sequence", async () => {
    const h = holder();
    const wire: string[] = [];

    const failing = withWriteLock(h, async () => {
      wire.push("F1");
      await Bun.sleep(2);
      throw new Error("write failed");
    }).catch(() => {});

    await Bun.sleep(1);
    const next = withWriteLock(h, async () => {
      wire.push("OK");
    });

    await Promise.all([failing, next]);
    expect(wire).toEqual(["F1", "OK"]);
  });
});
