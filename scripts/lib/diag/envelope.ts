/**
 * Measurement envelope — JSON wrapper written by `diag --write-to=<path>`
 * and consumed by `diag diff`. Shape lifted from borglike's
 * `scripts/lib/diagnose/file-output.ts`; kept deliberately generic so any
 * diag mode can emit one without re-inventing the git-capture + metadata
 * preamble.
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

declare const process: { version: string };

export interface GitInfo {
  gitSha: string;
  gitDirty: boolean;
}

export interface EnvelopeConfig {
  mode: string;
  tickDelta?: number;
  maxIters?: number;
  iters?: number;
  shape?: string;
  shapes?: string[];
  gitSha: string;
  gitDirty: boolean;
  nodeVersion: string;
}

export interface Envelope<TResult = unknown> {
  mode: string;
  timestamp: string;
  config: EnvelopeConfig;
  result: TResult;
}

export function captureGit(): GitInfo {
  try {
    const gitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const gitDirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
    return { gitSha, gitDirty };
  } catch {
    return { gitSha: 'unknown', gitDirty: false };
  }
}

export function writeEnvelope<T>(
  path: string,
  mode: string,
  config: Partial<EnvelopeConfig>,
  result: T,
): void {
  const git = captureGit();
  const envelope: Envelope<T> = {
    mode,
    timestamp: new Date().toISOString(),
    config: {
      mode,
      ...config,
      gitSha: git.gitSha,
      gitDirty: git.gitDirty,
      nodeVersion: process.version,
    },
    result,
  };
  writeFileSync(path, JSON.stringify(envelope, null, 2), 'utf8');
  console.log(
    `\n   envelope written to ${path} (git=${git.gitSha}${git.gitDirty ? '-dirty' : ''})`,
  );
}
