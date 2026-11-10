'use strict';

// Fixed synthetic suites only. This entry never launches the WorkBuddy product.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const H = require('./acceptance/harness');

const SUITES = [
  ['F05', 'f05-readonly-no-write.js'],
  ['F07', 'f07-protocol-boundary.js'],
  ['F12', 'f12-cross-session.js'],
];

function runSuite(id, file, env) {
  return new Promise((resolve) => {
    process.stdout.write(`\n--- bridge offline: ${id} ---\n`);
    const child = spawn(process.execPath, [path.join(__dirname, 'acceptance', file)], {
      cwd: H.PROJECT_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const resultLines = [];
    let spawnError;
    // Forward original bytes; parsing is separate and cannot replace raw output.
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line.startsWith('__RESULT__')) resultLines.push(line.slice('__RESULT__'.length).trim());
    });
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (code, signal) => {
      const errors = [];
      if (spawnError) errors.push(`spawn error: ${spawnError.code || spawnError.message}`);
      if (signal) errors.push(`signal: ${signal}`);
      if (code !== 0) errors.push(`exit: ${code}`);
      let result;
      if (resultLines.length !== 1) {
        errors.push(`expected one __RESULT__, received ${resultLines.length}`);
      } else {
        try {
          result = JSON.parse(resultLines[0]);
        } catch (error) {
          errors.push(`unparseable __RESULT__: ${error.message}`);
        }
      }
      if (result !== undefined) {
        if (!result || Array.isArray(result) || result.id !== id
            || !['pass', 'fail', 'skip', 'env'].every((key) =>
              Number.isInteger(result[key]) && result[key] >= 0)) {
          errors.push('invalid __RESULT__ identity or counters');
        } else if (result.verdict !== 'PASS' || result.pass === 0
            || result.fail !== 0 || result.skip !== 0 || result.env !== 0) {
          errors.push(`${result.verdict}: pass=${result.pass} fail=${result.fail} skip=${result.skip} env=${result.env}`);
        }
      }
      if (errors.length) process.stderr.write(`bridge offline ${id}: ${errors.join('; ')}\n`);
      resolve(errors.length === 0);
    });
  });
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Usage: node test/run-bridge-offline.js (no arguments)');
  const sandbox = H.makeSandbox('bridge-offline');
  let passed = 0;
  try {
    const env = H.baseEnv(sandbox, {
      WB_BRIDGE_STORE: sandbox.store,
      TMPDIR: sandbox.root,
      TMP: sandbox.root,
      TEMP: sandbox.root,
    });
    delete env.WB_REAL_WB;
    delete env.NODE_OPTIONS;
    delete env.ADP1A_FAULT_EVIDENCE_DIR;
    for (const [id, file] of SUITES) {
      if (await runSuite(id, file, env)) passed += 1;
    }
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
  process.stdout.write(`\nbridge offline: ${passed}/${SUITES.length} suites passed without FAIL/SKIP/ENV\n`);
  process.exitCode = passed === SUITES.length ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`bridge offline: ${error.stack || error}\n`);
  process.exitCode = 1;
});
