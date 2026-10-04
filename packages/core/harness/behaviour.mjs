// Behaviour-diff harness for JavaScript/TypeScript. Runs inside the sandbox.
//
//   node behaviour.mjs <plan.json> <out.json>
//
// plan: { root, frozenTime, seed, callTimeoutMs, maxMessageChars,
//         targets: [{ id, file, exportName, inputs: [[arg, ...], ...] }] }
// out:  { results: [{ id, loadError, calls: [outcome | null] }] }
// outcome: { returned, args } | { threw: { type, message } } | { timeout: true }
//
// Each call runs in a worker thread so a call that hangs can be stopped
// without losing the results of the others.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const MAX_DEPTH = 8;
const MAX_ITEMS = 100;
const MAX_STRING = 2000;

function encode(value, seen = new WeakSet(), depth = 0) {
  if (value === undefined) return { $undefined: true };
  if (value === null) return null;
  switch (typeof value) {
    case 'number':
      if (Number.isNaN(value)) return { $number: 'NaN' };
      if (!Number.isFinite(value)) return { $number: value > 0 ? 'Infinity' : '-Infinity' };
      if (Object.is(value, -0)) return { $number: '-0' };
      return value;
    case 'string':
      return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    case 'boolean':
      return value;
    case 'bigint':
      return { $bigint: value.toString() };
    case 'symbol':
      return { $symbol: value.description ?? '' };
    case 'function':
      return { $function: value.name || 'anonymous' };
  }
  if (seen.has(value)) return { $circular: true };
  if (depth >= MAX_DEPTH) return { $truncated: true };
  seen.add(value);
  try {
    const next = (v) => encode(v, seen, depth + 1);
    if (value instanceof Date) {
      return { $date: Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString() };
    }
    if (value instanceof Error) return { $error: value.name, message: String(value.message) };
    if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map(next);
    if (value instanceof Map) {
      return { $map: [...value].slice(0, MAX_ITEMS).map(([k, v]) => [next(k), next(v)]) };
    }
    if (value instanceof Set) return { $set: [...value].slice(0, MAX_ITEMS).map(next) };
    if (ArrayBuffer.isView(value)) {
      return {
        $bytes: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).slice(
          0,
          MAX_ITEMS,
        ),
      };
    }
    if (typeof value.then === 'function') return { $promise: true };
    const out = {};
    const proto = Object.getPrototypeOf(value);
    if (proto && proto !== Object.prototype && proto.constructor?.name) {
      out.$class = proto.constructor.name;
    }
    for (const key of Object.keys(value).sort().slice(0, MAX_ITEMS)) out[key] = next(value[key]);
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Inputs arrive as JSON; `{ "$undefined": true }` and friends stand for values JSON lacks. */
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    if (value.$undefined === true) return undefined;
    if (typeof value.$number === 'string')
      return Number(value.$number === '-0' ? -0 : value.$number);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decode(v);
    return out;
  }
  return value;
}

function freeze({ frozenTime, seed }) {
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const fixed = Date.parse(frozenTime);
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed]));
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FrozenDate;
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

async function worker() {
  const { plan, start } = workerData;
  freeze(plan);
  const calls = plan.targets.flatMap((t, ti) => t.inputs.map((_, ii) => [ti, ii]));
  const modules = new Map();

  for (let index = start; index < calls.length; index++) {
    const [ti, ii] = calls[index];
    const target = plan.targets[ti];

    if (!modules.has(ti)) {
      try {
        const mod = await import(pathToFileURL(join(plan.root, target.file)).href);
        const fn =
          target.exportName === 'default'
            ? mod.default
            : (mod[target.exportName] ?? mod.default?.[target.exportName]);
        if (typeof fn !== 'function')
          throw new Error(`${target.exportName} is not an exported function`);
        modules.set(ti, fn);
      } catch (error) {
        modules.set(ti, null);
        parentPort.postMessage({
          type: 'load',
          ti,
          error: clip(String(error?.message ?? error), plan.maxMessageChars),
        });
      }
    }
    const fn = modules.get(ti);
    if (!fn) {
      parentPort.postMessage({ type: 'call', index, outcome: null });
      continue;
    }

    const args = decode(JSON.parse(JSON.stringify(target.inputs[ii])));
    parentPort.postMessage({ type: 'start', index });
    let outcome;
    try {
      const value = await fn(...args);
      outcome = { returned: encode(value), args: encode(args) };
    } catch (error) {
      outcome = {
        threw: {
          type: error?.constructor?.name ?? typeof error,
          message: clip(String(error?.message ?? error), plan.maxMessageChars),
        },
      };
    }
    parentPort.postMessage({ type: 'call', index, outcome });
  }
}

function runFrom(plan, results, calls, start) {
  return new Promise((resolve) => {
    const child = new Worker(new URL(import.meta.url), { workerData: { plan, start } });
    let current = start;
    let timer = null;
    let settled = false;
    const finish = (next) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(next);
    };
    child.on('message', (msg) => {
      if (msg.type === 'load') {
        results[msg.ti].loadError = msg.error;
      } else if (msg.type === 'start') {
        current = msg.index;
        timer = setTimeout(() => {
          const [ti, ii] = calls[current];
          results[ti].calls[ii] = { timeout: true };
          child.terminate();
          finish(current + 1);
        }, plan.callTimeoutMs);
      } else if (msg.type === 'call') {
        clearTimeout(timer);
        const [ti, ii] = calls[msg.index];
        results[ti].calls[ii] = msg.outcome;
        current = msg.index + 1;
      }
    });
    child.on('error', (error) => {
      const [ti, ii] = calls[current] ?? [];
      if (ti !== undefined) {
        results[ti].calls[ii] = {
          threw: {
            type: 'Crash',
            message: clip(String(error?.message ?? error), plan.maxMessageChars),
          },
        };
      }
      finish(current + 1);
    });
    child.on('exit', (code) => {
      if (current >= calls.length) return finish(calls.length);
      // The code under test ended the worker (e.g. process.exit). Record it and go on.
      const [ti, ii] = calls[current];
      results[ti].calls[ii] ??= { threw: { type: 'Exit', message: `exited with code ${code}` } };
      finish(current + 1);
    });
  });
}

async function main() {
  const [planPath, outPath] = process.argv.slice(2);
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const calls = plan.targets.flatMap((t, ti) => t.inputs.map((_, ii) => [ti, ii]));
  const results = plan.targets.map((t) => ({
    id: t.id,
    loadError: null,
    calls: t.inputs.map(() => null),
  }));
  let next = 0;
  while (next < calls.length) next = await runFrom(plan, results, calls, next);
  writeFileSync(outPath, JSON.stringify({ results }));
}

if (isMainThread) await main();
else await worker();
