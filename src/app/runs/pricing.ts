import type { MessageUsage } from "./stream.js";

/**
 * What an attempt cost when it ended without the CLI's result line (a crash, a Stop, sleep, SIGKILL): the
 * streamed tokens of its messages at list prices. Only for keeping the approved Claude cap honest; the
 * CLI's own total_cost_usd wins whenever there is one. Unknown models are priced at the dearest family,
 * so the estimate errs high.
 */

interface Rate {
  /** $ per million tokens. Cache writes are 1.25× input (5-minute) and 2× input (1-hour). */
  input: number;
  output: number;
  cacheRead: number;
}

const RATES: [RegExp, Rate][] = [
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/opus-(5|4-[5-9])\b/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/opus/, { input: 15, output: 75, cacheRead: 1.5 }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/haiku-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/haiku/, { input: 1, output: 5, cacheRead: 0.1 }],
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 1 }],
];
const DEAREST: Rate = { input: 15, output: 75, cacheRead: 1.5 };

export function rateFor(model: string | undefined): Rate {
  return (model && RATES.find(([re]) => re.test(model))?.[1]) || DEAREST;
}

/** List-price cost of one message's tokens. */
export function messageUsd(u: MessageUsage, model: string | undefined): number {
  const r = rateFor(model);
  return (u.input * r.input + u.output * r.output + u.cacheRead * r.cacheRead + u.cacheWrite5m * r.input * 1.25 + u.cacheWrite1h * r.input * 2) / 1e6;
}

/** The estimated cost of an attempt's messages (one entry per message id). */
export function estimateUsd(messages: Iterable<{ model?: string; usage: MessageUsage }>, fallbackModel?: string): number {
  let total = 0;
  for (const m of messages) total += messageUsd(m.usage, m.model ?? fallbackModel);
  return total;
}
