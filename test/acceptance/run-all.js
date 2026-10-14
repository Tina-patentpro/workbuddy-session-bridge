'use strict';

/**
 * 独立验收套件汇总运行器。
 *
 * 逐个以子进程运行 f01..f13，解析各自末尾的 `__RESULT__ {json}` 行，输出矩阵。
 * 每个用例文件都可单独运行；run-all 只负责汇总与退出码聚合。
 *
 * 用法：
 *   node test/acceptance/run-all.js            # 跑全部（F01 优先）
 *   node test/acceptance/run-all.js F02 F07    # 只跑指定项
 *
 * 退出码：存在 FAIL 时为 1，否则 0（ENV/SKIP 不算产品失败）。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DIR = __dirname;
const NODE = process.execPath;

/** 固定的运行顺序：F01 必须最先，避免任何写测试先于哨兵保护。 */
const ORDER = [
  'F01', 'F02', 'F02B', 'F02C', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'F13',
];

/** 文件映射（编号 -> 文件名）。编号支持可选的字母后缀（如 F02B）。 */
function discover() {
  const map = {};
  for (const f of fs.readdirSync(DIR)) {
    const m = f.match(/^(f\d{2}[a-z]?)-[a-z0-9-]+\.js$/);
    if (m) map[m[1].toUpperCase()] = path.join(DIR, f);
  }
  return map;
}

/**
 * 运行一个用例文件。
 *
 * @param {string} id 编号。
 * @param {string} file 文件路径。
 * @return {Promise<Object>} {id, verdict, pass, fail, skip, env, failures, exitCode, tail}
 */
function runOne(id, file) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [file], { cwd: path.resolve(DIR, '..', '..'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 240000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const m = out.match(/__RESULT__ (\{.*\})/);
      let parsed = null;
      if (m) { try { parsed = JSON.parse(m[1]); } catch { parsed = null; } }
      resolve({
        id,
        verdict: parsed ? parsed.verdict : 'ERROR',
        pass: parsed ? parsed.pass : 0,
        fail: parsed ? parsed.fail : 0,
        skip: parsed ? parsed.skip : 0,
        env: parsed ? parsed.env : 0,
        failures: parsed ? parsed.failures : ['(无 __RESULT__ 行；脚本可能崩溃)'],
        exitCode: code,
        tail: out.split('\n').slice(-6).join('\n'),
      });
    });
  });
}

(async () => {
  const map = discover();
  const wanted = process.argv.slice(2).map((s) => s.toUpperCase());
  const ids = ORDER.filter((id) => map[id] && (wanted.length === 0 || wanted.includes(id)));

  process.stdout.write(`验收矩阵运行：${ids.join(', ')}\n\n`);

  const results = [];
  for (const id of ids) {
    process.stdout.write(`\n########## ${id} ##########\n`);
    const r = await runOne(id, map[id]);
    results.push(r);
    if (r.verdict === 'ERROR') process.stdout.write(`${r.tail}\n`);
  }

  const pad = (s, n) => String(s).padEnd(n);
  process.stdout.write('\n==================== 验收矩阵 ====================\n');
  process.stdout.write(`${pad('ID', 6)}${pad('VERDICT', 9)}${pad('PASS', 6)}${pad('FAIL', 6)}${pad('SKIP', 6)}${pad('ENV', 6)}\n`);
  process.stdout.write('-'.repeat(39) + '\n');
  for (const r of results) {
    process.stdout.write(`${pad(r.id, 6)}${pad(r.verdict, 9)}${pad(r.pass, 6)}${pad(r.fail, 6)}${pad(r.skip, 6)}${pad(r.env, 6)}\n`);
  }

  const failing = results.filter((r) => r.verdict === 'FAIL' || r.verdict === 'ERROR');
  process.stdout.write('-'.repeat(39) + '\n');
  process.stdout.write(`合计：FAIL/ERROR ${failing.length} 项，其余 ${results.length - failing.length} 项\n`);

  if (failing.length > 0) {
    process.stdout.write('\n失败明细:\n');
    for (const r of failing) {
      process.stdout.write(`  [${r.id}] ${r.verdict}\n`);
      for (const f of (r.failures || [])) process.stdout.write(`      - ${f}\n`);
    }
  }

  process.exit(failing.length > 0 ? 1 : 0);
})().catch((e) => {
  process.stderr.write(`run-all 失败: ${(e && e.stack) || e}\n`);
  process.exit(1);
});
