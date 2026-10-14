'use strict';

/**
 * F01 · P0 · 原包 QA 的清理步骤会删除测试前已存在的队列目录
 *
 * 验收目标（02 号文档「闭合验收条件」）：
 *   预先放置至少两个旧文件并记录哈希；无论用例成功、断言失败、子进程异常退出，
 *   都不得删除或改写它们。仅本次创建的临时目录可被清理。放在任何写入测试之前。
 *
 * 隔离策略（遵守主理人硬性约束：绝不触碰真实 ~/.workbuddy）：
 *   - 先做静态证据：若 qa-verify.js 仍对硬编码的真实用户路径做无条件递归清理，
 *     直接判 FAIL，并**拒绝执行**该脚本（以免删掉真实队列）。
 *   - 仅当静态检查确认清理目标不再是隔离目录外的硬编码路径时，才在隔离 HOME 下动态执行。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const H = require('./harness');

/** 被测 QA 脚本（归属另一位工程师，本套件只读不改）。 */
const QA_VERIFY = path.join(H.PROJECT_ROOT, 'test', 'qa-verify.js');

/** 计算文件 SHA-256。 */
function sha(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 静态分析 qa-verify.js 的清理边界，返回证据对象。 */
function analyzeCleanup() {
  const src = fs.readFileSync(QA_VERIFY, 'utf8');
  const realWbMatch = src.match(/const\s+REAL_WB\s*=\s*'([^']+)'/);
  const realWb = realWbMatch ? realWbMatch[1] : null;
  // 清理目标是否由 REAL_WB 派生（典型：const dir = path.join(REAL_WB, 'task-bridge')）
  const dirFromRealWb = /const\s+dir\s*=\s*path\.join\(\s*REAL_WB/.test(src);
  // 是否存在递归删除
  const recursiveRm = /rmSync\s*\([^)]*recursive\s*:\s*true/.test(src);
  // 是否存在「所有权标记」核验（修复后的正向信号）
  const hasOwnershipMarker = /ownership|ownerMarker|createdByThisRun|mkdtempMarker|OWNER_MARKER|_OWNED_/i.test(src);
  const lines = src.split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/rmSync\s*\(/.test(lines[i]) && /\bdir\b/.test(lines[i])) {
      offenders.push(`${i + 1}: ${lines[i].trim()}`);
    }
  }
  return { realWb, dirFromRealWb, recursiveRm, hasOwnershipMarker, offenders };
}

(async () => {
  process.stdout.write('=== F01 · P0 · 清理边界哨兵保护 ===\n');
  const sandbox = H.makeSandbox('f01');

  const stat = analyzeCleanup();

  // ---- 静态证据 1：不得无条件递归清理硬编码（非本次创建）路径 ----
  await H.check('F01.1 qa-verify.js 不无条件递归清理硬编码真实路径', () => {
    H.assert(!(stat.realWb && stat.dirFromRealWb && stat.recursiveRm),
      `qa-verify.js 仍对硬编码路径 ${stat.realWb} 做无条件递归清理（F01 未修复）。命中行:\n        ${stat.offenders.join('\n        ') || '(rmSync 行)'}`);
  });

  // ---- 静态证据 2：清理必须绑定「本次创建」的所有权标记 ----
  await H.check('F01.2 清理绑定所有权标记（仅清理本次创建）', () => {
    if (!stat.recursiveRm) return; // 无递归清理则天然安全
    H.assert(stat.hasOwnershipMarker,
      'qa-verify.js 存在递归清理，但未发现任何所有权标记核验；无法证明只清理本次创建目录');
  });

  // ---- 动态证据：哨兵保护（仅在可安全执行时运行）----
  const safeToRun = !(stat.realWb && stat.dirFromRealWb && stat.recursiveRm);

  await H.check('F01.3 预置哨兵在 qa-verify 运行后原样存在（哈希一致）', async () => {
    if (!safeToRun) {
      H.raiseSkip('qa-verify.js 仍清理硬编码真实路径，拒绝执行以保护真实用户数据（静态证据 F01.1 已判 FAIL）');
    }
    // 在隔离 HOME 下预置两个旧文件（模拟「测试前已存在的队列」）
    const bridgeDir = path.join(sandbox.home, '.workbuddy', 'task-bridge');
    fs.mkdirSync(bridgeDir, { recursive: true });
    const s1 = path.join(bridgeDir, 'KEEP-EXISTING-QUEUE.txt');
    const s2 = path.join(bridgeDir, 'KEEP-EXISTING-2.json');
    fs.writeFileSync(s1, 'SENTINEL-1-DO-NOT-DELETE\n');
    fs.writeFileSync(s2, '{"keep":true,"tag":"F01-SENTINEL"}\n');
    const h1 = sha(s1);
    const h2 = sha(s2);

    const child = spawn(H.NODE_BIN, [QA_VERIFY], {
      cwd: H.PROJECT_ROOT,
      env: H.baseEnv(sandbox),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 90000);
      child.on('exit', () => { clearTimeout(t); resolve(); });
    });

    H.assert(fs.existsSync(s1) && fs.existsSync(s2), `哨兵文件被删除（qa-verify 输出尾部:\n${out.slice(-800)}）`);
    H.assert(sha(s1) === h1, '哨兵 KEEP-EXISTING-QUEUE.txt 被改写');
    H.assert(sha(s2) === h2, '哨兵 KEEP-EXISTING-2.json 被改写');
  });

  H.finish('F01', safeToRun ? '动态执行已启用' : '动态执行因安全护栏被抑制（静态证据仍有效）');
})().catch((e) => { H.fail('F01 harness', (e && e.stack) || String(e)); H.finish('F01'); });
