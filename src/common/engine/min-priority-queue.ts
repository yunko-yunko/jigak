/** Stable minimum queue. Values must keep their priority while queued; ties retain insertion order. */
export class MinPriorityQueue<T> {
  private readonly entries: {
    value: T;
    order: number;
  }[] = [];
  private nextOrder = 0;

  constructor(private readonly compare: (left: T, right: T) => number) {}

  get size(): number {
    return this.entries.length;
  }

  peek(): T | undefined {
    return this.entries[0]?.value;
  }

  push(value: T): void {
    const entry = {
      value,
      order: this.nextOrder++,
    };
    let index = this.entries.length;

    this.entries.push(entry);

    while (index > 0) {
      const parent = (index - 1) >>> 1;

      if (this.priority(this.entries[parent], entry) <= 0) {
        break;
      }

      this.entries[index] = this.entries[parent];
      index = parent;
    }

    this.entries[index] = entry;
  }

  pop(): T | undefined {
    const first = this.entries[0],
      last = this.entries.pop();

    if (!first || !last) {
      return undefined;
    }

    if (this.entries.length) {
      let index = 0;

      while (index * 2 + 1 < this.entries.length) {
        let child = index * 2 + 1;

        if (
          child + 1 < this.entries.length &&
          this.priority(this.entries[child + 1], this.entries[child]) < 0
        ) {
          child++;
        }

        if (this.priority(last, this.entries[child]) <= 0) {
          break;
        }

        this.entries[index] = this.entries[child];
        index = child;
      }

      this.entries[index] = last;
    }

    return first.value;
  }

  private priority(
    left: {
      value: T;
      order: number;
    },
    right: {
      value: T;
      order: number;
    },
  ): number {
    return this.compare(left.value, right.value) || left.order - right.order;
  }
}
