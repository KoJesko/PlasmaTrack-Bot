// Structured logger that never writes secrets.
//
// Two layers: any field whose key looks like a credential is replaced, and any
// string containing a registered secret value (bot token, service tokens, a
// player token that is in flight) has that value masked.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Mask this value wherever it appears from now on. */
  addSecret(value: string): void;
}

export type LogSink = (level: LogLevel, line: string) => void;

const SENSITIVE_KEY = /token|secret|authorization|password|signature|api[-_]?key|cookie/i;
export const REDACTED = '[redacted]';

export function createLogger(sink: LogSink = consoleSink, secrets: string[] = []): Logger {
  const known = new Set(secrets.filter((s) => s.length >= 8));

  const redactString = (s: string): string => {
    let out = s;
    for (const secret of known) out = out.split(secret).join(REDACTED);
    // Interaction webhook URLs carry a 15-minute credential in the path.
    out = out.replace(/(\/webhooks\/\d+\/)[A-Za-z0-9._-]+/g, `$1${REDACTED}`);
    return out;
  };

  const redact = (value: unknown, depth: number): unknown => {
    if (depth > 8) return '[depth]';
    if (typeof value === 'string') return redactString(value);
    if (value instanceof Error) {
      return { name: value.name, message: redactString(value.message) };
    }
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
      }
      return out;
    }
    return value;
  };

  const write = (level: LogLevel, msg: string, fields?: LogFields) => {
    const entry = { level, msg: redactString(msg), ...(fields ? (redact(fields, 0) as LogFields) : {}) };
    sink(level, JSON.stringify(entry));
  };

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    addSecret: (value) => {
      if (value.length >= 8) known.add(value);
    },
  };
}

function consoleSink(level: LogLevel, line: string): void {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
