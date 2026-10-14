'use strict';

/* ──────────────────────────────────────────────────────────────────────────
 * [已退役 / RETIRED] 2026-10-09 —— 第三轮外部审计整改（存储方案锁定为 maildir）
 * ----------------------------------------------------------------------------
 * 原因：本脚本考察「rename 退避是否放大持锁状态下的 LOCK_TIMEOUT」，而新设计**已删除锁**
 *   （不存在 LOCK_TIMEOUT）；同时领取改为 link/unlink，rename 仅用于唯一目标的原子发布。
 * 处置（遵循「不得静默删除既有测试」）：**保留存档、不删除**，但**不再计入有效验证**。
 *   等价保证已由下列现行用例接管：
 *     并发读压力下零丢失（原子发布 + 退避）         → test/qa-verify.js  D12-5
 *     退避预算为逐次取整上界                          → test/qa-verify.js  D12-7
 * 如需历史运行，请使用旧版本仓库；本文件正文保留原样仅作存档。
 * ────────────────────────────────────────────────────────────────────────── */
if (process.env.WB_RUN_RETIRED_HELPERS !== '1') {
  process.stderr.write('[RETIRED] qa2-rename-amplify：针对已删除的 lockfile 设计；等价保证见 test/qa-verify.js D12-5 / D12-7。\n');
  process.exit(0);
}

/**
 * QA 第2轮诊断：跨进程 rename 退避是否真实发生，以及它是否放大 LOCK_TIMEOUT。
 *
 * 关注点：P0 修复把 rename 失败改为「16 次指数退避（最坏 2502ms）」，
 * 而这段退避发生在**持锁状态**下；锁获取总预算只有 1000ms。
 * 若跨进程 rename 真的会重试，则 P0 修复会放大 LOCK_TIMEOUT 概率。
 *
 * 运行：node test/helpers/qa2-rename-amplify.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server.js');
const NODE_BIN = process.execPath;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-amplify-'));
const STORE = path.join(DIR, 'store', 'instructions.json');

/**
 * 生成一个「写」worker：连续投递 N 条，并把每次失败的错误码回报。
 *
 * @param {string} tag worker 标签。
 * @param {number} n 投递条数。
 * @return {string} 脚本。
 */
function writerScript(tag, n) {
  return [
    "const { spawn } = require('child_process');",
    `const child = spawn(process.execPath, [${JSON.stringify(SERVER)}], { stdio: ['pipe','pipe','inherit'],`,
    `  env: { ...process.env, TASK: '1', WB_BRIDGE_STORE: ${JSON.stringify(STORE)}, WB_BRIDGE_LOG: '0' } });`,
    "let buf=''; child.stdout.setEncoding('utf8');",
    "child.stdout.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\\n'))!==-1){const l=buf.slice(0,i);buf=buf.slice(i+1);if(l.trim())emit(l);}});",
    'const pend=new Map();let nid=1;',
    'function emit(l){let m;try{m=JSON.parse(l);}catch(_){return;}if(m.id!==undefined&&pend.has(m.id)){const r=pend.get(m.id);pend.delete(m.id);r(m);}}',
    'function call(n,a){const id=nid++;return new Promise(res=>{pend.set(id,res);child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method:"tools/call",params:{name:n,arguments:a}})+"\\n");});}',
    '(async()=>{',
    '  const errs=[]; let ok=0;',
    `  for(let k=0;k<${n};k++){`,
    `    const r=await call('wb_send_instruction',{instruction:'${tag}-'+k});`,
    "    if(r.result&&r.result.isError){const e=JSON.parse(r.result.content[0].text).error;errs.push(e.code);}",
    '    else ok++;',
    '  }',
    `  child.kill(); process.stdout.write('@@@'+JSON.stringify({ok,errs})); process.exit(0);`,
    '})();',
  ].join('\n');
}

/**
 * 生成一个「裸 fs 忙读者」脚本，持续读 store 制造 rename 竞争。
 *
 * @param {number} ms 持续毫秒。
 * @return {string} 脚本。
 */
function rawReaderScript(ms) {
  return [
    "const fs=require('fs');",
    `const p=${JSON.stringify(STORE)};`,
    'let n=0;const t0=Date.now();',
    `while(Date.now()-t0<${ms}){n++;try{fs.readFileSync(p,'utf8');}catch(e){}}`,
    "process.stdout.write('@@@'+JSON.stringify({reads:n}));process.exit(0);",
  ].join('\n');
}

/**
 * 运行一个脚本并取回 @@@ 报告。
 *
 * @param {string} script 脚本。
 * @return {Promise<Object>} 报告。
 */
function run(script) {
  return new Promise((resolve) => {
    const p = spawn(NODE_BIN, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (c) => { out += c; });
    p.on('exit', () => {
      const i = out.indexOf('@@@');
      resolve(i === -1 ? { err: out.slice(-300) } : JSON.parse(out.slice(i + 3)));
    });
  });
}

/**
 * 主流程。
 *
 * @return {Promise<void>} 完成。
 */
async function main() {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify({ version: 1, updatedAt: '', instructions: [] }, null, 2), 'utf8');

  // 场景1：2 写 + 2 裸fs读者（贴近目标部署形态：Codex 写 / WorkBuddy 读）
  const s1 = await Promise.all([
    run(writerScript('a', 60)),
    run(writerScript('b', 60)),
    run(rawReaderScript(5000)),
    run(rawReaderScript(5000)),
  ]);
  const f1 = JSON.parse(fs.readFileSync(STORE, 'utf8')).instructions.length;
  const e1 = [].concat(s1[0].errs || [], s1[1].errs || []);
  process.stdout.write('=== 场景1: 2 写进程 x 60 + 2 裸fs读者（贴近真实部署）===\n');
  process.stdout.write(`  落盘=${f1}/120 | 成功=${(s1[0].ok || 0) + (s1[1].ok || 0)}/120 | 失败码分布=${JSON.stringify(countBy(e1))}\n`);
  process.stdout.write(`  裸fs读次数: ${(s1[2].reads || 0) + (s1[3].reads || 0)}\n`);

  // 场景2：4 写 + 2 读者（高竞争，检验放大效应）
  const s2 = await Promise.all([
    run(writerScript('c', 60)),
    run(writerScript('d', 60)),
    run(writerScript('e', 60)),
    run(writerScript('f', 60)),
    run(rawReaderScript(6000)),
    run(rawReaderScript(6000)),
  ]);
  const f2Total = JSON.parse(fs.readFileSync(STORE, 'utf8')).instructions.length;
  // 场景2 复用同一 store，需扣除场景1 已落盘的 f1 条才是本场景落盘数
  const f2 = f2Total - f1;
  const e2 = [].concat(s2[0].errs || [], s2[1].errs || [], s2[2].errs || [], s2[3].errs || []);
  const ok2 = (s2[0].ok || 0) + (s2[1].ok || 0) + (s2[2].ok || 0) + (s2[3].ok || 0);
  process.stdout.write('\n=== 场景2: 4 写进程 x 60 + 2 裸fs读者（高竞争）===\n');
  process.stdout.write(`  落盘=${f2} | 成功=${ok2}/240 | 失败码分布=${JSON.stringify(countBy(e2))}\n`);
  process.stdout.write(`  裸fs读次数: ${(s2[4].reads || 0) + (s2[5].reads || 0)}\n`);

  process.stdout.write('\n=== 结论 ===\n');
  const silentLoss = (expected) => f2Total - (ok2 + (e2.filter((e) => e === 'LOCK_TIMEOUT').length)) === 0;
  process.stdout.write(`场景1 落盘===成功: ${f1 === (s1[0].ok || 0) + (s1[1].ok || 0) ? '是（零丢失）' : '否！'}\n`);
  process.stdout.write(`场景2 本场景落盘=${f2}/240 | 累计落盘=${f2Total} | 成功=${ok2}/240\n`);
  process.stdout.write(`STORE_WRITE_FAILED（真正的静默丢失）: 场景1=${e1.filter((e) => e === 'STORE_WRITE_FAILED').length} 场景2=${e2.filter((e) => e === 'STORE_WRITE_FAILED').length}\n`);
  process.stdout.write(`LOCK_TIMEOUT（显式可恢复失败）: 场景1=${e1.filter((e) => e === 'LOCK_TIMEOUT').length} 场景2=${e2.filter((e) => e === 'LOCK_TIMEOUT').length}\n`);
  process.stdout.write(`\n判读：只要「落盘数 === 成功入队数」且 STORE_WRITE_FAILED 为 0，则无静默丢失；\n`);
  process.stdout.write(`      LOCK_TIMEOUT 是调用方可见的显式失败（可重试），不构成数据丢失。\n`);
  void silentLoss;

  fs.rmSync(DIR, { recursive: true, force: true });
}

/**
 * 统计错误码分布。
 *
 * @param {string[]} list 错误码列表。
 * @return {Object} 分布。
 */
function countBy(list) {
  const o = {};
  for (const x of list) o[x] = (o[x] || 0) + 1;
  return o;
}

main().catch((e) => {
  process.stdout.write(`FATAL: ${e && e.stack ? e.stack : String(e)}\n`);
  process.exit(2);
});
