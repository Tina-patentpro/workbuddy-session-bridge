'use strict';

/**
 * F09 · P2 · 退避预算并非精确的逐次上界，且声明预算不约束真实持锁时长
 *
 * 验收目标（02 号文档「闭合验收条件」）：
 *   配置边界、最后一次失败不等待、每次取整和最大抖动必须覆盖；对实际等待累计不低估。
 *   保留加载期拒绝启动反例（破坏不等式 → 服务拒绝启动）。
 *
 * 目标语义：totalBackoffBudget() 必须是不低估的精确上界
 *   —— 逐次 ceil、含抖动、按 attempts-1 次等待累计。
 */

const fs = require('fs');
const path = require('path');
const H = require('./harness');

/** 逐次 ceil 的精确上界（waits 次等待，每次延迟上限 ceil(exp*(1+jitter))）。 */
function exactPerCeilUpperBound(cfg, waits) {
  const jitter = typeof cfg.jitterRatio === 'number' ? cfg.jitterRatio : 0;
  let sum = 0;
  for (let i = 0; i < waits; i += 1) {
    const exp = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** i);
    sum += Math.max(1, Math.ceil(exp * (1 + jitter)));
  }
  return sum;
}

/** 尝试从候选导出名中取退避配置。 */
function pickConfigs(store) {
  const out = {};
  for (const name of ['LOCK_RETRY', 'RENAME_RETRY', 'RETRY', 'RETRY_CONFIG']) {
    const cfg = store[name];
    if (cfg && typeof cfg === 'object' && typeof cfg.attempts === 'number' && typeof cfg.baseDelayMs === 'number' && typeof cfg.maxDelayMs === 'number') {
      out[name] = cfg;
    }
  }
  return out;
}

(async () => {
  process.stdout.write('=== F09 · P2 · 退避预算精确性 + 加载期不变量 ===\n');

  let store = null;
  try {
    store = require(path.join(H.PROJECT_ROOT, 'lib', 'store.js'));
  } catch (e) {
    store = null;
  }

  await H.check('F09.1 totalBackoffBudget() 为不低估的精确上界（逐次 ceil / attempts-1 次等待）', () => {
    if (!store) H.raiseEnv('无法加载 lib/store.js');
    let budget = store.totalBackoffBudget;
    if (typeof budget !== 'function') {
      const key = Object.keys(store).find((k) => /budget/i.test(k) && typeof store[k] === 'function');
      if (!key) H.raiseEnv('未导出任何退避预算函数（若因重构移除，请更新本用例的探测点）');
      budget = store[key];
    }
    const configs = pickConfigs(store);
    const names = Object.keys(configs);
    if (names.length === 0) H.raiseEnv('未找到任何退避配置（*_RETRY）无法计算上界');
    const problems = [];
    for (const name of names) {
      const cfg = configs[name];
      const exact = exactPerCeilUpperBound(cfg, cfg.attempts - 1);
      const actual = budget(cfg);
      if (actual < exact) problems.push(`${name}: 报告 ${actual} < 精确上界 ${exact}（低估）`);
      else if (actual !== exact) problems.push(`${name}: 报告 ${actual} != 精确上界 ${exact}（非精确）`);
    }
    H.assert(problems.length === 0, `退避预算不精确:\n        ${problems.join('\n        ')}`);
  });

  await H.check('F09.2 破坏加载期不等式 → 服务拒绝启动', () => {
    if (!store) H.raiseEnv('无法加载 lib/store.js');
    const src = fs.readFileSync(path.join(H.PROJECT_ROOT, 'lib', 'store.js'), 'utf8');
    // 找到参与不变量的数值常量并破坏它
    let mutated = null;
    let knob = null;
    const csb = src.match(/(CRITICAL_SECTION_BUDGET_MS\s*=\s*)(\d+)/);
    const stale = src.match(/(LOCK_STALE_MS\s*=\s*)(\d+)/);
    if (csb) {
      mutated = src.replace(csb[0], `${csb[1]}999999999`);
      knob = 'CRITICAL_SECTION_BUDGET_MS→超大';
    } else if (stale) {
      mutated = src.replace(stale[0], `${stale[1]}1`);
      knob = 'LOCK_STALE_MS→1';
    }
    if (!mutated) H.raiseSkip('未在 lib/store.js 找到可破坏的预算常量（不变量可能已重构）');

    // 复制 lib 到隔离目录后写入破坏版副本，隔离验证加载期断言
    const sandbox = H.makeSandbox('f09');
    const libSrc = path.join(H.PROJECT_ROOT, 'lib');
    const libDst = path.join(sandbox.root, 'lib');
    fs.mkdirSync(libDst, { recursive: true });
    for (const f of fs.readdirSync(libSrc)) {
      if (f.endsWith('.js')) fs.copyFileSync(path.join(libSrc, f), path.join(libDst, f));
    }
    fs.writeFileSync(path.join(libDst, 'store.js'), mutated);

    let threw = false;
    try {
      delete require.cache[require.resolve(path.join(libDst, 'store.js'))];
      require(path.join(libDst, 'store.js'));
    } catch (e) {
      threw = true;
    }
    H.assert(threw, `破坏不变量（${knob}）后加载未抛错——加载期断言失效`);
  });

  H.finish('F09');
})().catch((e) => { H.fail('F09 harness', (e && e.stack) || String(e)); H.finish('F09'); });
