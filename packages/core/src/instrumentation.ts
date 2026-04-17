interface TimingEntry {
  count: number;
  totalMs: number;
}

let timings: Record<string, TimingEntry> = {};
let stack: string[] = [];

export function beginInstrumentation() {
  timings = {};
  stack = [];
}

export function getTimings(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, entry] of Object.entries(timings)) {
    out[name] = Math.round(entry.totalMs * 100) / 100;
  }
  return out;
}

export function instrumentReplicadExports(exports: Record<string, any>) {
  const seenProtos = new WeakSet<object>();
  for (const [name, value] of Object.entries(exports)) {
    if (typeof value !== "function") continue;
    const proto = value.prototype;
    const isClass =
      proto &&
      typeof proto === "object" &&
      Object.getOwnPropertyNames(proto).some((k) => k !== "constructor");
    if (isClass) {
      instrumentPrototype(name, proto, seenProtos);
    } else {
      exports[name] = wrap(name, value);
    }
  }
}

function instrumentPrototype(
  className: string,
  proto: any,
  seen: WeakSet<object>
) {
  if (!proto || seen.has(proto) || proto === Object.prototype) return;
  seen.add(proto);
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === "constructor") continue;
    const desc = Object.getOwnPropertyDescriptor(proto, key);
    if (!desc) continue;
    if (typeof desc.value === "function" && desc.writable) {
      const opName = `${className}.${key}`;
      desc.value = wrap(opName, desc.value);
      Object.defineProperty(proto, key, desc);
    }
  }
  const parent = Object.getPrototypeOf(proto);
  if (parent && parent !== Object.prototype) {
    instrumentPrototype(className, parent, seen);
  }
}

function wrap(name: string, original: Function): Function {
  return function wrapped(this: any, ...args: any[]) {
    stack.push(name);
    const start = performance.now();
    try {
      const result = original.apply(this, args);
      if (result && typeof (result as any).then === "function") {
        return (result as Promise<any>).then(
          (v) => {
            record(name, start);
            stack.pop();
            return v;
          },
          (err) => {
            record(name, start);
            stack.pop();
            tagError(err);
            throw err;
          }
        );
      }
      record(name, start);
      stack.pop();
      return result;
    } catch (err) {
      record(name, start);
      stack.pop();
      tagError(err);
      throw err;
    }
  };
}

function record(name: string, start: number) {
  const delta = performance.now() - start;
  const entry = timings[name] || { count: 0, totalMs: 0 };
  entry.count += 1;
  entry.totalMs += delta;
  timings[name] = entry;
}

function tagError(err: any) {
  if (!err || typeof err !== "object") return;
  const outermost = stack[0];
  if (outermost && !err.operation) {
    err.operation = outermost;
  }
}
