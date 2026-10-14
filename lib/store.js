'use strict';

/**
 * 指令队列存储（唯一可写的数据）—— **maildir 模式（单写入者 / 每记录独立文件）**。
 *
 * 语义：本连接器**无法**直接驱动 WorkBuddy 会话（其 sendPrompt / runPrompt 走 Electron
 * 进程内 postMessage bridge，外部进程不可达）。因此写入侧采用「投递队列 + WorkBuddy 侧取件」：
 * 外部 agent 追加指令，WorkBuddy 内的 agent 通过 wb_pending_instructions 拉取执行。
 *
 * ------------------------------------------------------------------------
 * 【第三轮外部审计 F02 / F05 / F09 / F10 整改：废弃 lockfile，改为 maildir】
 * ------------------------------------------------------------------------
 * 旧实现用「单文件 instructions.json + 同目录 lockfile + 锁龄超时抢占」做互斥。
 * 审计反例证明：`stat → unlink` 不是原子所有权协议，持锁者被暂停（或两个清锁者交错）
 * 时会出现「两个调用都返回成功、最终只留一条」的静默丢失。任何「等待时间 / 锁龄」
 * 数值都不构成对进程暂停的约束。因此彻底删除锁机制，改为：
 *
 *   目录布局（<root> 由 WB_BRIDGE_STORE / WB_BRIDGE_DIR / 默认 task-bridge 决定）：
 *     <root>/pending/<id>.json   待取件
 *     <root>/picked/<id>.json    已被某消费者领取
 *     <root>/done/<id>.json      已完成
 *     <root>/failed/<id>.json    已失败
 *     <root>/tmp/<...>.tmp       写入暂存区（只在此产生半成品）
 *
 *   互斥模型：**每记录独立文件 + 原子链接（link+unlink）**。
 *     - enqueue    = 写 `tmp/<id>.<rand>.tmp` → rename 到 `pending/<id>.json`。回执在 rename 成功后才返回。
 *     - 取件（markPicked）= `link(pending/<id>.json → picked/<id>.json)`，**目标已存在(EEXIST)即为竞争失败**；
 *       链接成功后立即 `unlink(pending/<id>.json)`。只有链接成功者是领取者（不会双领）。
 *     - complete   = `link(<src>/<id>.json → done|failed/<id>.json)` 作为终态声明，同样原子且互斥。
 *   由于不同调用写的是不同文件，**不存在「读到旧快照再整体覆盖」的丢失路径**，
 *   也无需任何锁、锁龄、心跳或 PID 存活判断。文件名即唯一标识，内容在每次状态迁移时原子替换。
 *
 *   【为什么领取用 link 而不是 rename（D12-1 根因修复）】
 *     在 Windows/libuv 上，并发对**同一源、同一目标**执行 `fs.renameSync` 会偶发「两个调用都返回成功」
 *     的幻影 OK（实测 4 并发约 2 个返回成功），即 **rename 不能充当互斥领取原语**：两个消费者会同时
 *     认为自己领取了同一条记录，进而把同一记录同时写入两个状态目录（表现为「落盘数 > 成功入队数」）。
 *     而 `linkSync` 在目标存在时**确定性地**返回 EEXIST，且链接成功瞬间目标即拥有完整内容
 *     （与已写完的源为同一 inode），不存在「半截文件」窗口。实测 6 进程 × 30 轮并发领取恒为**恰好一个成功者**。
 *     迁移完成后再删除源名；若删除失败会显式上抛，绝不静默留下重复记录。
 *
 *   【为什么必须「从源链接」而非「从 tmp 链接」（D11-2「复活」根因修复）】
 *     互斥锚点必须是 `link(源 → 目标)`：link 的**原子前提是源此刻存在**（ENOENT ⇒ 已被并发迁移）。
 *     若改为 `link(tmp → 目标)`（旧实现），源是否存在**完全不参与判定**——于是「扫描时仍在 pending 的
 *     陈旧候选」，会在记录已被并发领取并完成（pending→picked→done）后，被重新链接进 picked（复活），
 *     造成同一记录**同时存在于 picked 与 done**（表现同样为「落盘数 > 成功入队数」且 id 重复）。
 *     故有源迁移一律：`link(源→目标)` 占位 → `rename(tmp→目标)` 原子替换新内容 → 删源名；
 *     任一步失败都不会落到「目标已删、源已删」的丢失态（实测 60 轮 × 8 进程不再复现）。
 *
 *   【D11-2b 「复活窗口」自愈：link 与 rename 之间被并发完成抢占】
 *     `link(源→目标)` 只保证「进入临界区的唯一性」，但内容替换 `rename(tmp→目标)` 是**第二步**。
 *     当目标为 picked 且并发「完成」在两步之间先行（阶段二 `picked→done` 会先建 done 再删 picked），
 *     第二步 rename 就会把已完成的记录**复活**成一个孤立 picked 副本 → 同一 id 同现于 picked 与 done。
 *     自愈依据不变式：**删除 picked/<id> 者必先创建 done|failed/<id>**。故迁移目标为 picked 且同 id
 *     已处终态时，判定该副本为复活产物并删除（判竞争失败），彻底杜绝跨状态重复（12 进程 × 60 轮压测不再复现）。
 *
 *   【D11-2c 错误路径收敛 + GONE 语义分离（故障模拟确定性复现修复）】
 *     故障模拟暴露两类错误路径缺陷：
 *     (1) 错误路径无收敛：`rename(tmp→目标)` 失败或 `removeSourceLink(源)` 失败时直接抛错，不核验记录
 *         是否已被并发推进 ⇒ 静止状态残留「pending + done」跨状态双份。修复：
 *         - 锚点 link 成功后，内容 rename 失败**不撤销领取**（锚点已在，记录已在目标状态就位），仅保留旧内容继续；
 *         - 删源失败时调用 `reconcileAbortedTransition` 收敛到**恰好一个**状态目录（终态优先；否则保留更靠前
 *           的 picked，清源失败则回退保留源；绝不二者都留，也绝不误删致丢失）。
 *     (2) GONE 语义过载：`link(picked→done)` 的 ENOENT 被一律当作「已被并发完成」。但「picked 被并发回滚」
 *         同样产生 ENOENT。`complete()` 现**核验终态是否真实存在**：存在 → INSTRUCTION_ALREADY_FINAL；
 *         不存在 → INSTRUCTION_CLAIM_LOST（可重试），杜绝「误报终态 → 记录被重复执行」。
 *
 * 读操作（stats / markPicked=false 预览）严格只读：**不 mkdir、不写、不 rename、不移动**。
 * JSON 损坏不会被「移动备份后当空队列」，而是被显式统计并上报（F05）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pathsMod = require('./paths');
const { AppError, JSONRPC_ERRORS } = require('./protocol');

/** 存储结构版本。 */
const STORE_VERSION = 2;
/** 记录文件后缀。 */
const RECORD_SUFFIX = '.json';
/** 临时文件后缀。 */
const TMP_SUFFIX = '.tmp';

/** 指令状态取值（与子目录一一对应）。 */
const STATUSES = Object.freeze(['pending', 'picked', 'done', 'failed']);

/** 状态 -> 子目录名。 */
const STATUS_TO_DIR = Object.freeze({
  pending: 'pending',
  picked: 'picked',
  done: 'done',
  failed: 'failed',
});

/** 优先级取值。 */
const PRIORITIES = Object.freeze(['low', 'normal', 'high']);

/**
 * 原子文件操作的退避参数（指数退避），供「发布 rename」与「领取 link/unlink」共用。
 *
 * Windows 上当目标文件正被另一进程打开读取时 `rename` / `link` / `unlink` 会抛 EPERM / EACCES。
 * 这正是本连接器的目标部署形态（Codex 侧写、WorkBuddy 侧读），故这些操作必须带退避重试；
 * 重试耗尽后抛结构化错误，**绝不静默丢弃**。
 */
const RENAME_RETRY = Object.freeze({
  attempts: 8,
  baseDelayMs: 2,
  maxDelayMs: 64,
  /** 抖动比例：delay × (1 ± jitterRatio)，避免多写入者同相位重试。 */
  jitterRatio: 0.25,
  /** 可重试的 errno：目标被占用类。 */
  retryableCodes: Object.freeze(['EPERM', 'EACCES', 'EBUSY']),
});

/**
 * 单条记录一次状态迁移（写 tmp + rename）的最坏耗时预算（毫秒）。
 *
 * 【F09 整改】旧实现的预算链把「锁等待预算」当作安全保证，但数学不等式无法约束
 * 进程暂停。锁机制已删除，此常量现在只用于「单条迁移预算」的加载期一致性断言，
 * 明确区分「配置退避预算」与「真实 I/O / 调度时长」，不再冒充锁存活证明。
 */
const CRITICAL_SECTION_BUDGET_MS = 400;

/** 单次队列操作最多迁移的记录数（同时作为 takePending 的 limit 硬上限）。 */
const MAX_TRANSITIONS_PER_OPERATION = 50;

/** 单次队列操作的声明预算上界（毫秒）：覆盖 ≤ MAX_TRANSITIONS_PER_OPERATION 条迁移。 */
const QUEUE_OPERATION_BUDGET_MS = 30000;

/** 任何单次存储操作的硬截止（毫秒）。 */
const STORE_OPERATION_DEADLINE_MS = 60000;

/**
 * 计算第 `attempt` 次重试延时的**最坏可达整数值**（与 backoffDelay 的单次 ceil 口径一致）。
 *
 * 【F09 整改】backoffDelay 返回 `max(1, ceil(delay))`，抖动上界为 `exponential × (1 + jitter)`，
 * 故单次最坏值 = `max(1, ceil(exponential × (1 + jitter)))`。预算求和必须逐次按此上界累加，
 * 而不是先求和无抖动基准再整体乘一次抖动（旧实现的做法，会产生 ~1ms 偏差）。
 *
 * @param {{baseDelayMs: number, maxDelayMs: number, jitterRatio: (number|undefined)}} config 退避配置。
 * @param {number} attempt 尝试序号（从 0 开始）。
 * @return {number} 最坏延迟毫秒数（整数）。
 */
function worstCaseDelayMs(config, attempt) {
  const exponential = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** attempt);
  const jitter = config.jitterRatio || 0;
  return Math.max(1, Math.ceil(exponential * (1 + jitter)));
}

/**
 * 计算一组退避参数在「实际睡眠次数」上的最坏总时长（毫秒）。
 *
 * 【F09 整改】`sleepCount` 默认为 `attempts - 1`：重试循环最后一次失败后不再 sleep
 * （本文件的 rename 循环即为此语义），故预算只累加真实发生的等待次数，避免高估。
 *
 * @param {{attempts: number, baseDelayMs: number, maxDelayMs: number, jitterRatio: (number|undefined)}} config 退避配置。
 * @param {number} [sleepCount] 实际睡眠次数；缺省为 `attempts - 1`。
 * @return {number} 最坏总时长（毫秒）。
 */
function totalBackoffBudget(config, sleepCount) {
  const sleeps = Number.isFinite(sleepCount) ? Math.max(0, Math.floor(sleepCount)) : Math.max(0, config.attempts - 1);
  let total = 0;
  for (let attempt = 0; attempt < sleeps; attempt += 1) {
    total += worstCaseDelayMs(config, attempt);
  }
  return total;
}

/**
 * 加载期自检存储预算不变量（≥3 条有意义的不等式，任一被破坏即拒绝启动）。
 *
 * 【F09 整改】旧实现的「临界区预算 < 锁等待总预算 < 陈旧锁存活上限」链条与整个锁机制一起退役。
 * 新链用于约束「单条迁移 → 单次操作 → 硬截止」的时间上界：
 *
 *   rename 最坏退避(238ms)  <  单条迁移预算(400ms)  <  单次操作预算(30000ms)  <  硬截止(60000ms)
 *   且 单条迁移预算 × 单次操作最大迁移数(50) <= 单次操作预算（400×50 = 20000 <= 30000）
 *
 * @return {Array<{name: string, value: number}>} 链条（供诊断）。
 * @throws {Error} 任一不等式不成立时抛出。
 */
function assertBudgetInvariant() {
  const renameWorst = totalBackoffBudget(RENAME_RETRY);
  const chain = [
    { name: 'rename 最坏退避', value: renameWorst },
    { name: '单条迁移预算 CRITICAL_SECTION_BUDGET_MS', value: CRITICAL_SECTION_BUDGET_MS },
    { name: '单次操作预算 QUEUE_OPERATION_BUDGET_MS', value: QUEUE_OPERATION_BUDGET_MS },
    { name: '存储操作硬截止 STORE_OPERATION_DEADLINE_MS', value: STORE_OPERATION_DEADLINE_MS },
  ];
  for (let i = 1; i < chain.length; i += 1) {
    if (!(chain[i - 1].value < chain[i].value)) {
      throw new Error(
        `[store] 预算不变量被破坏：${chain[i - 1].name}(${chain[i - 1].value}) 必须 < ` +
          `${chain[i].name}(${chain[i].value})。`,
      );
    }
  }
  const perOpWorst = CRITICAL_SECTION_BUDGET_MS * MAX_TRANSITIONS_PER_OPERATION;
  if (!(perOpWorst <= QUEUE_OPERATION_BUDGET_MS)) {
    throw new Error(
      `[store] 预算不变量被破坏：单条迁移预算(${CRITICAL_SECTION_BUDGET_MS}) × 最大迁移数(${MAX_TRANSITIONS_PER_OPERATION}) ` +
        `= ${perOpWorst} 必须 <= 单次操作预算(${QUEUE_OPERATION_BUDGET_MS})。`,
    );
  }
  return chain;
}

assertBudgetInvariant();

/**
 * 同步睡眠（Node 无同步 sleep，这里用 Atomics 等待）。
 *
 * @param {number} ms 毫秒数。
 * @return {void}
 */
function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/**
 * 计算第 `attempt` 次重试的退避时长：指数增长 + 封顶 + 抖动。
 *
 * @param {{baseDelayMs: number, maxDelayMs: number, jitterRatio: (number|undefined)}} config 退避配置。
 * @param {number} attempt 当前尝试序号（从 0 开始）。
 * @return {number} 实际睡眠毫秒数（向上取整，最小 1ms）。
 */
function backoffDelay(config, attempt) {
  const exponential = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** attempt);
  const jitter = config.jitterRatio || 0;
  const spread = exponential * jitter;
  const delay = exponential - spread + Math.random() * spread * 2;
  return Math.max(1, Math.ceil(delay));
}

/**
 * 带指数退避的原子 rename：把 `from` 覆盖式移动到 `to`。
 *
 * 用于把写好的 tmp 文件「发布」为正式记录文件。目标可能被并发读取者短暂占用（Windows
 * EPERM/EACCES），故带退避重试；重试耗尽抛结构化 STORE_RENAME_FAILED。
 *
 * @param {string} from 源路径（暂存文件）。
 * @param {string} to 目标路径。
 * @param {{attempts?: number, baseDelayMs?: number, maxDelayMs?: number, retryableCodes?: string[], jitterRatio?: number}} [options] 重试参数。
 * @return {void}
 * @throws {AppError} 全部重试失败时抛出 STORE_RENAME_FAILED。
 */
function renameWithRetry(from, to, options = {}) {
  const attempts = Number.isFinite(options.attempts) ? options.attempts : RENAME_RETRY.attempts;
  const baseDelayMs = Number.isFinite(options.baseDelayMs) ? options.baseDelayMs : RENAME_RETRY.baseDelayMs;
  const maxDelayMs = Number.isFinite(options.maxDelayMs) ? options.maxDelayMs : RENAME_RETRY.maxDelayMs;
  const retryableCodes = Array.isArray(options.retryableCodes) ? options.retryableCodes : RENAME_RETRY.retryableCodes;
  const jitterRatio = Number.isFinite(options.jitterRatio) ? options.jitterRatio : RENAME_RETRY.jitterRatio;
  const config = { attempts, baseDelayMs, maxDelayMs, jitterRatio };

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!retryableCodes.includes(error && error.code)) break;
      if (attempt === attempts - 1) break;
      sleepSync(backoffDelay(config, attempt));
    }
  }
  throw new AppError(
    'STORE_RENAME_FAILED',
    `原子 rename 重试 ${attempts} 次仍失败（目标可能被占用）: ${lastError && lastError.message}`,
    JSONRPC_ERRORS.INTERNAL_ERROR,
    {
      from,
      to,
      attempts,
      baseDelayMs,
      maxDelayMs,
      maxTotalBackoffMs: totalBackoffBudget(config),
      lastErrorCode: lastError ? lastError.code || null : null,
    },
  );
}

/**
 * 原子硬链接（源 → 目标），**但不删除源**（maildir 领取的底层互斥原语）。
 *
 * 【D12-1 根因修复】见文件头「为什么领取用 link 而不是 rename」。
 *   - `fs.linkSync(src, dst)` 成功 ⇒ 本进程是**唯一**领取者，且**源此刻确实存在**（link 的原子前提）。
 *   - 抛 EEXIST ⇒ 目标已存在，竞争失败（`reason:'EXISTS'`），由调用方静默跳过。
 *   - 抛 ENOENT ⇒ 源已被他人迁移（`reason:'GONE'`），同样跳过——这是「防止复活已迁走记录」的关键。
 *   - 其它可重试 errno（EPERM/EACCES/EBUSY）⇒ 指数退避重试。
 *   调用方在**新内容就位**后再自行 `removeSourceLink(srcPath)`（V1 修复：先建目标、后删源，避免丢失）。
 *
 * @param {string} srcPath 源（当前状态）文件。
 * @param {string} destPath 目标（新状态）文件。
 * @return {{ok: boolean, reason: (string|null), attempts: number}} 结果；ok=false 表示竞争失败。
 * @throws {AppError} 不可恢复错误或重试耗尽时抛 STORE_RENAME_FAILED。
 */
function linkWithRetry(srcPath, destPath) {
  let lastError = null;
  for (let attempt = 0; attempt < RENAME_RETRY.attempts; attempt += 1) {
    try {
      fs.linkSync(srcPath, destPath);
    } catch (error) {
      lastError = error;
      const code = error && error.code;
      if (code === 'ENOENT') return { ok: false, reason: 'GONE', attempts: attempt + 1 };
      if (code === 'EEXIST') return { ok: false, reason: 'EXISTS', attempts: attempt + 1 };
      if (!RENAME_RETRY.retryableCodes.includes(code)) break;
      if (attempt === RENAME_RETRY.attempts - 1) break;
      sleepSync(backoffDelay(RENAME_RETRY, attempt));
      continue;
    }
    // 链接成功：本进程是唯一领取者，且**源此刻确实存在**（link 的原子前提）。
    return { ok: true, reason: null, attempts: attempt + 1 };
  }
  throw new AppError(
    'STORE_RENAME_FAILED',
    `竞争性领取 link 失败: ${lastError && lastError.message}`,
    JSONRPC_ERRORS.INTERNAL_ERROR,
    {
      from: srcPath,
      to: destPath,
      lastErrorCode: lastError ? lastError.code || null : null,
      maxTotalBackoffMs: totalBackoffBudget(RENAME_RETRY),
    },
  );
}

/**
 * 竞争性领取 / 状态迁移：**原子硬链接（源 → 目标）+ 删除源名**（maildir 经典做法）。
 *
 * 等价于 `linkWithRetry(...)` 成功后再 `removeSourceLink(srcPath)`。保留此函数以兼容既有调用。
 *
 * @param {string} srcPath 源（当前状态）文件。
 * @param {string} destPath 目标（新状态）文件。
 * @return {{ok: boolean, reason: (string|null), attempts: number}} 结果；ok=false 表示竞争失败。
 * @throws {AppError} 不可恢复错误或重试耗尽时抛 STORE_RENAME_FAILED。
 */
function claimLink(srcPath, destPath) {
  const linked = linkWithRetry(srcPath, destPath);
  if (linked.ok) removeSourceLink(srcPath);
  return linked;
}

/**
 * 删除已被硬链接接管的源文件（带退避重试）。
 *
 * 链接成功后目标名已持久；若源名残留，同一记录会同时出现在两个状态目录（统计虚高、状态歧义）。
 * 因此 unlink 失败**必须显式上抛**（STORE_RENAME_FAILED），绝不静默留下重复。
 *
 * @param {string} srcPath 源文件路径。
 * @return {void}
 * @throws {AppError} 重试耗尽仍无法删除时抛出。
 */
function removeSourceLink(srcPath) {
  for (let attempt = 0; attempt < RENAME_RETRY.attempts; attempt += 1) {
    try {
      fs.unlinkSync(srcPath);
      return;
    } catch (error) {
      const code = error && error.code;
      if (code === 'ENOENT') return; // 已被清理，等价成功。
      const retryable = RENAME_RETRY.retryableCodes.includes(code);
      if (!retryable || attempt === RENAME_RETRY.attempts - 1) {
        throw new AppError(
          'STORE_RENAME_FAILED',
          `领取后删除源文件失败: ${error && error.message}`,
          JSONRPC_ERRORS.INTERNAL_ERROR,
          { srcPath, lastErrorCode: code || null, attempts: attempt + 1 },
        );
      }
      sleepSync(backoffDelay(RENAME_RETRY, attempt));
    }
  }
}

/**
 * 指令排序：优先级降序，其次创建时间升序（先进先出）。
 *
 * @param {Object} a 指令 A。
 * @param {Object} b 指令 B。
 * @return {number} 比较结果。
 */
function compareForPick(a, b) {
  const rank = { high: 0, normal: 1, low: 2 };
  const rankA = rank[a.priority] === undefined ? 1 : rank[a.priority];
  const rankB = rank[b.priority] === undefined ? 1 : rank[b.priority];
  if (rankA !== rankB) return rankA - rankB;
  return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

/**
 * 指令队列存储（maildir）。
 */
class InstructionStore {
  /**
   * @param {Object} layout 路径布局（来自 paths.resolveLayout）。
   */
  constructor(layout) {
    if (!layout || typeof layout.storeRoot !== 'string' || layout.storeRoot.length === 0) {
      throw new AppError('STORE_CONFIG_INVALID', '缺少有效的 storeRoot 布局', JSONRPC_ERRORS.INTERNAL_ERROR);
    }
    // 构造期只做内存赋值 + 只读校验，**不创建任何目录**（零副作用）。
    const validation = pathsMod.validateStoreRoot(layout.storeRoot);
    if (!validation.ok) {
      throw new AppError('STORE_CONFIG_INVALID', `存储根配置非法：${validation.reason}`, JSONRPC_ERRORS.INTERNAL_ERROR, {
        storeRoot: layout.storeRoot,
        reason: validation.reason,
      });
    }
    this.root = validation.value;
    this.bridgeDir = layout.bridgeDir || this.root;
    this.parts = layout.storeParts && layout.storeParts.root === this.root
      ? layout.storeParts
      : pathsMod.storeParts(this.root);
  }

  /**
   * 确保队列根目录与全部子目录存在（仅写路径调用）。
   *
   * @return {void}
   */
  ensureDirs() {
    for (const sub of pathsMod.STORE_SUBDIRS) {
      const dir = path.join(this.root, sub);
      const within = pathsMod.assertWithinRoot(dir, this.root);
      if (!within.ok) {
        throw new AppError('STORE_PATH_OUT_OF_ROOT', `存储子目录越出根目录: ${within.resolved}`, JSONRPC_ERRORS.INTERNAL_ERROR, {
          dir,
          reason: within.reason,
        });
      }
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 解析单条记录文件（严格校验）。
   *
   * @param {string} filePath 记录文件路径。
   * @return {(Object|null)} 记录；文件不存在返回 null。
   * @throws {AppError} JSON 损坏或结构非法时抛 RECORD_CORRUPT；IO 错误抛 STORE_READ_FAILED。
   */
  readRecordFile(filePath) {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw new AppError('STORE_READ_FAILED', `读取指令记录失败: ${error && error.message}`, JSONRPC_ERRORS.INTERNAL_ERROR, {
        filePath,
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_error) {
      throw new AppError('RECORD_CORRUPT', `指令记录 JSON 损坏: ${path.basename(filePath)}`, JSONRPC_ERRORS.INTERNAL_ERROR, {
        filePath,
      });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.id !== 'string' || parsed.id.length === 0) {
      throw new AppError('RECORD_CORRUPT', `指令记录结构错误（缺少字符串 id）: ${path.basename(filePath)}`, JSONRPC_ERRORS.INTERNAL_ERROR, {
        filePath,
      });
    }
    return parsed;
  }

  /**
   * 只读扫描一个状态目录（**零写入**）。
   *
   * 损坏记录不会被移动或删除，而是收集进 `corrupt` 由调用方显式上报（F05）。
   *
   * @param {string} dir 目录路径。
   * @param {string} status 该目录对应的状态名。
   * @return {{entries: Array<{record: Object, filePath: string}>, corrupt: Array<{file: string, code: string}>}} 扫描结果。
   */
  scanDir(dir, status) {
    const entries = [];
    const corrupt = [];
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // 目录不存在 / 尚未创建 / 非目录：视为空，不产生副作用。
      return { entries, corrupt };
    }
    for (const dirent of dirents) {
      if (!dirent.isFile()) continue;
      if (!dirent.name.toLowerCase().endsWith(RECORD_SUFFIX)) continue;
      const filePath = path.join(dir, dirent.name);
      try {
        const record = this.readRecordFile(filePath);
        if (!record) continue;
        // 目录是状态的**权威来源**；文件内 status 字段仅作交叉核对。
        record.status = status;
        entries.push({ record, filePath });
      } catch (error) {
        corrupt.push({ file: dirent.name, code: error && error.code ? error.code : 'CORRUPT' });
      }
    }
    return { entries, corrupt };
  }

  /**
   * 扫描全部状态目录。
   *
   * @return {{byStatus: Object<string, Array<{record: Object, filePath: string}>>, corrupt: Array<{file: string, status: string, code: string}>}} 全量扫描。
   */
  scanAll() {
    const byStatus = { pending: [], picked: [], done: [], failed: [] };
    const corrupt = [];
    for (const status of STATUSES) {
      const dir = path.join(this.root, STATUS_TO_DIR[status]);
      const scanned = this.scanDir(dir, status);
      byStatus[status] = scanned.entries;
      for (const item of scanned.corrupt) corrupt.push({ ...item, status });
    }
    return { byStatus, corrupt };
  }

  /**
   * 原子写入一条记录文件：写 `<tmp>/<id>.<rand>.tmp` → rename 到 `<dir>/<id>.json`。
   *
   * @param {string} dir 目标状态目录。
   * @param {Object} record 记录内容（应含字符串 id）。
   * @return {void}
   * @throws {AppError} 写入或 rename 失败时抛出。
   */
  writeRecordFile(dir, record) {
    const within = pathsMod.assertWithinRoot(dir, this.root);
    if (!within.ok) {
      throw new AppError('STORE_PATH_OUT_OF_ROOT', `目标目录越出根目录: ${within.resolved}`, JSONRPC_ERRORS.INTERNAL_ERROR, {
        dir,
        reason: within.reason,
      });
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(this.parts.tmp, { recursive: true });

    const payload = {
      ...record,
      storeVersion: STORE_VERSION,
    };
    const tmpPath = path.join(this.parts.tmp, `${record.id}.${crypto.randomBytes(6).toString('hex')}${TMP_SUFFIX}`);
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
      this.discard(tmpPath);
      throw new AppError('STORE_WRITE_FAILED', `写入临时记录失败: ${error && error.message}`, JSONRPC_ERRORS.INTERNAL_ERROR, {
        tmpPath,
      });
    }
    try {
      renameWithRetry(tmpPath, path.join(dir, `${record.id}${RECORD_SUFFIX}`));
    } catch (error) {
      this.discard(tmpPath);
      throw error instanceof AppError
        ? error
        : new AppError('STORE_WRITE_FAILED', `原子发布记录失败: ${error && error.message}`, JSONRPC_ERRORS.INTERNAL_ERROR, { tmpPath });
    }
  }

  /**
   * 竞争性状态迁移：把「新内容」原子发布到目标状态目录，并删除源状态名。
   *
   * 【D12-1 根因修复】互斥锚点是**目标文件名**（`<destDir>/<id>.json`），由 `link` 唯一创建。
   *
   * 【D11-2「复活」根因修复】当**有源**时，互斥锚点改为「**源 → 目标** 的原子 link」：
   *   - 源已被并发迁移 ⇒ ENOENT ⇒ GONE（**关键**：不再把已迁走的记录「复活」到目标目录）；
   *   - 目标已存在     ⇒ EEXIST ⇒ EXISTS（他人已领取）。
   *   旧实现从 `tmp` 链接，**源是否存在完全不参与判定**：于是「扫描时仍在 pending 的陈旧候选」，
   *   在记录已被并发领取并完成（pending→picked→done）后，仍会被重新链接进 picked，产生重复。
   *   新内容的落地顺序保证不丢失：先 `link(源→目标)` 占位，再 `rename(tmp→目标)` 原子替换内容，
   *   最后才删除源名；任一步失败都不会出现「目标已删、源已删」的丢失态。
   *
   * @param {string} srcPath 源（当前状态）文件；可为空表示新增（新增时直接以 tmp 发布）。
   * @param {string} destDir 目标状态目录。
   * @param {Object} record 要写入的新记录内容（须含字符串 id）。
   * @return {{ok: boolean, reason: (string|null), attempts: number}} ok=false 表示竞争失败（EXISTS/GONE）。
   * @throws {AppError} 路径越出 / 写入或迁移失败时抛出。
   */
  claimWithContent(srcPath, destDir, record) {
    const within = pathsMod.assertWithinRoot(destDir, this.root);
    if (!within.ok) {
      throw new AppError('STORE_PATH_OUT_OF_ROOT', `目标目录越出根目录: ${within.resolved}`, JSONRPC_ERRORS.INTERNAL_ERROR, {
        dir: destDir,
        reason: within.reason,
      });
    }
    fs.mkdirSync(destDir, { recursive: true });
    fs.mkdirSync(this.parts.tmp, { recursive: true });

    const tmpPath = path.join(this.parts.tmp, `${record.id}.${crypto.randomBytes(6).toString('hex')}${TMP_SUFFIX}`);
    const destPath = path.join(destDir, `${record.id}${RECORD_SUFFIX}`);
    const payload = { ...record, storeVersion: STORE_VERSION };
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
      this.discard(tmpPath);
      throw new AppError('STORE_WRITE_FAILED', `写入临时记录失败: ${error && error.message}`, JSONRPC_ERRORS.INTERNAL_ERROR, {
        tmpPath,
      });
    }

    const hasSource = Boolean(srcPath) && path.resolve(srcPath) !== path.resolve(destPath);
    const destIsPicked = path.resolve(destDir) === path.resolve(this.parts.picked);

    // ---- 新增（无源）：以 tmp 直接原子发布到目标（目标唯一）----
    if (!hasSource) {
      let created;
      try {
        created = claimLink(tmpPath, destPath);
      } finally {
        this.discard(tmpPath); // 成功时 claimLink 已删源（tmp）；失败时清理暂存。
      }
      return created;
    }

    // ---- 迁移（有源）：互斥锚点 = link(源 → 目标)，**源是否存在参与原子判定** ----
    const linked = linkWithRetry(srcPath, destPath);
    if (!linked.ok) {
      this.discard(tmpPath); // 竞争失败（EXISTS/GONE）：清理暂存并跳过，绝不复活已迁走的记录。
      return linked;
    }

    // 锚点 link(源→目标) 已成功 ⇒ 记录**此刻已在目标状态就位**（link 的成功即「已领取」）。
    // 内容替换（写 pickedAt / result）是「就地增强」，其失败**不得**撤销本次领取：
    // 若失败即回滚目标，会把已领取的记录凭空撤回源状态，使并发完成者对 picked 的
    // link(picked→done) 落入 ENOENT 而被**误判为「已终态」**（D11-2c 变体3 根因）。
    // 故 rename 失败时保留目标占位（内容为旧值；status 由目录权威决定，歧义可忽略），继续收尾。
    try {
      renameWithRetry(tmpPath, destPath);
    } catch (_contentError) {
      // 目标仍在（锚点未丢）；仅内容保持旧值。不抛出、不回滚。
    }
    this.discard(tmpPath); // rename 成功后 tmp 已不存在；失败时清理暂存。

    // 删除旧状态名（maildir 迁移收尾）。失败时**收敛**，确保静止状态同 id 唯一（D11-2c 变体1/2 根因）。
    try {
      removeSourceLink(srcPath);
    } catch (error) {
      this.reconcileAbortedTransition(record.id, srcPath, destPath, destIsPicked);
      throw error;
    }

    // ---- 【D11-2b 复活窗口自愈】link(源→目标) 与 rename(tmp→目标) 之间存在窗口 ----
    // 目标为 picked 时，并发的「完成」可能在阶段二（picked→done|failed）先行：它 link(picked→终态)
    // 后 **删除 picked/<id>**；此后本进程的 rename(tmp→picked/<id>) 会把已被完成的记录**复活**成
    // 一个新 picked 副本 → 同一 id 同时存在于 picked 与 done|failed（落盘数 > 成功入队数）。
    // 关键不变式：**任何删除 picked/<id> 的路径，都必然先创建 done|failed/<id>**（终态先落地）。
    // 故若本进程目标为 picked 且同 id 已现于终态目录，则本副本必为复活产物 → 删除并判竞争失败。
    // 该自愈在正常路径（无并发完成）下恒不触发：此时 done|failed/<id> 不存在。
    if (destIsPicked) {
      const donePath = path.join(this.parts.done, `${record.id}${RECORD_SUFFIX}`);
      const failedPath = path.join(this.parts.failed, `${record.id}${RECORD_SUFFIX}`);
      if (fs.existsSync(donePath) || fs.existsSync(failedPath)) {
        this.discard(destPath);
        return { ok: false, reason: 'GONE', attempts: linked.attempts };
      }
    }
    return linked;
  }

  /**
   * 迁移中止后的「收敛」：把同一 id 归并回**恰好一个**状态目录，杜绝跨状态静止双份。
   *
   * 【D11-2c 根因修复】错误路径（rename / removeSourceLink 失败）此前直接抛错，从不核验记录是否
   * 已被并发者推进，可能留下「pending + done」跨状态双份（落盘数 > 成功入队数）。收敛规则：
   *   1. 目标为 picked（领取迁移）：
   *      a. 已有终态(done|failed) ⇒ 终态为准：清目标占位 + 清源残片（best-effort）；
   *      b. 否则在「目标(picked)」与「源(pending)」间保留**更靠前**的 picked；清源失败则回退保留源；
   *         二者都推进不了（仅一方存在）则不动，**绝不误删导致丢失**。
   *   2. 目标为 done|failed（完成迁移）：回退到源(picked)——未写入 result 的终态无意义；源已不在则保留目标。
   *
   * @param {string} id 记录 id。
   * @param {string} srcPath 源（迁移前）文件路径。
   * @param {string} destPath 目标（迁移后）文件路径。
   * @param {boolean} destIsPicked 目标是否为 picked 目录（区分「领取」与「完成」两类迁移）。
   * @return {void}
   */
  reconcileAbortedTransition(id, srcPath, destPath, destIsPicked) {
    const donePath = path.join(this.parts.done, `${id}${RECORD_SUFFIX}`);
    const failedPath = path.join(this.parts.failed, `${id}${RECORD_SUFFIX}`);
    const hasSrc = Boolean(srcPath) && fs.existsSync(srcPath);
    const hasDest = fs.existsSync(destPath);

    if (destIsPicked) {
      if (fs.existsSync(donePath) || fs.existsSync(failedPath)) {
        // 记录已被并发完成：终态优先，清掉目标占位与源残片。
        this.discard(destPath);
        if (hasSrc) {
          try { removeSourceLink(srcPath); } catch (_e) { /* best-effort：终态已落地 */ }
        }
        return;
      }
      if (hasSrc && hasDest) {
        try {
          removeSourceLink(srcPath); // 前进：保留 picked 占位
        } catch (_e) {
          this.discard(destPath); // 无法清源：回退，保留源(pending) 为唯一副本
        }
      }
      return;
    }

    // 完成迁移（dest 为 done|failed）：回退到源(picked)，记录仍可被重试完成。
    if (hasSrc) this.discard(destPath);
  }

  /**
   * 清理残留临时文件（失败不影响主流程）。
   *
   * @param {string} tmpPath 临时文件路径。
   * @return {void}
   */
  discard(tmpPath) {
    try { fs.unlinkSync(tmpPath); } catch (_error) { /* ignore */ }
  }

  /**
   * 追加一条指令：写 tmp → rename 到 pending。**回执在 rename 成功之后才返回。**
   *
   * @param {{instruction: string, sessionId: (string|null), priority: string, metadata: (Object|null)}} input 指令内容。
   * @return {{id: string, queueStatus: string, createdAt: string, position: number, queueDepth: number}} 入队结果。
   */
  enqueue(input) {
    this.ensureDirs();
    const createdAt = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      instruction: input.instruction,
      sessionId: input.sessionId,
      priority: input.priority,
      createdAt,
      pickedAt: null,
      completedAt: null,
      result: null,
      metadata: input.metadata,
      status: 'pending',
    };
    this.writeRecordFile(this.parts.pending, record);
    const scanned = this.scanDir(this.parts.pending, 'pending');
    const pending = scanned.entries.map((item) => item.record).sort(compareForPick);
    const position = pending.findIndex((item) => item.id === record.id) + 1;
    return {
      id: record.id,
      queueStatus: 'pending',
      createdAt,
      position: position > 0 ? position : pending.length,
      queueDepth: pending.length,
      corruptPending: scanned.corrupt.length,
    };
  }

  /**
   * 拉取待处理指令。
   *
   * markPicked=false 时为**纯预览**：只读 pending 目录，零写入。
   * markPicked=true 时逐条 `rename(pending → picked)` 原子领取，竞争失败者跳过。
   *
   * @param {{sessionId: (string|null), limit: number, markPicked: boolean}} input 拉取参数。
   * @return {{instructions: Object[], count: number, markPicked: boolean, remainingPending: number, corruptPending: number}} 拉取结果。
   */
  takePending(input) {
    const limit = Math.min(Math.max(1, Math.floor(input.limit) || 1), MAX_TRANSITIONS_PER_OPERATION);
    const scanned = this.scanDir(this.parts.pending, 'pending');
    const candidates = scanned.entries
      .map((item) => item)
      .filter((item) => !input.sessionId || item.record.sessionId === input.sessionId)
      .sort((a, b) => compareForPick(a.record, b.record));

    const selected = candidates.slice(0, limit);

    if (!input.markPicked) {
      // 纯预览：零写入。
      return {
        instructions: selected.map((item) => ({ ...item.record })),
        count: selected.length,
        markPicked: false,
        remainingPending: scanned.entries.length,
        corruptPending: scanned.corrupt.length,
      };
    }

    this.ensureDirs();
    const nowIso = new Date().toISOString();
    const pickedRecords = [];
    for (const item of selected) {
      // 领取 = 把「新内容（含 pickedAt）」原子发布到 picked 目录，并删除 pending 旧名。
      // 互斥锚点为 picked/<id>：EXISTS ⇒ 已被他人领取，跳过。领取后**不再回写** picked，避免重建。
      const updated = { ...item.record, status: 'picked', pickedAt: nowIso };
      const claimed = this.claimWithContent(item.filePath, this.parts.picked, updated);
      if (!claimed.ok) continue; // 竞争失败（EXISTS/GONE）：已被他人领取，跳过。
      pickedRecords.push(updated);
    }

    const after = this.scanDir(this.parts.pending, 'pending');
    return {
      instructions: pickedRecords,
      count: pickedRecords.length,
      markPicked: true,
      remainingPending: after.entries.length,
      corruptPending: after.corrupt.length,
    };
  }

  /**
   * 回填执行结果：把记录原子迁移到 done/failed 终态目录。
   *
   * 【D12-1 根因修复 · 两阶段】complete 允许直接作用于 pending 记录（wb_pending_instructions
   * 默认 markPicked=true，但也可能尚未取件）。若直接 `pending → done`，会与并发的「取件
   * `pending → picked`」形成**两个不同目标目录的竞争**（link 互斥只对同一目标生效），导致同一记录
   * 同时落在 picked 与 done（重复）。因此改为两阶段：
   *   阶段一：确保记录位于 picked（对 `picked/<id>` 互斥领取，与取件共享同一锚点）；
   *   阶段二：`picked → done|failed`（对终态目录名互斥）。
   * 每阶段都以「携带完整内容的 link」完成领取，成功方**不再回写**，杜绝重建重复。
   *
   * @param {{instructionId: string, result: unknown, status: string}} input 回填参数。
   * @return {Object} 更新后的指令记录。
   * @throws {AppError} 指令不存在（INSTRUCTION_NOT_FOUND）或已处于终态（INSTRUCTION_ALREADY_FINAL）。
   */
  complete(input) {
    this.ensureDirs();
    const id = input.instructionId;
    const destDirName = STATUS_TO_DIR[input.status] || STATUS_TO_DIR.done;

    const donePath = path.join(this.parts.done, `${id}${RECORD_SUFFIX}`);
    const failedPath = path.join(this.parts.failed, `${id}${RECORD_SUFFIX}`);
    const pickedPath = path.join(this.parts.picked, `${id}${RECORD_SUFFIX}`);
    const pendingPath = path.join(this.parts.pending, `${id}${RECORD_SUFFIX}`);

    // 幂等：已处于终态直接拒绝。
    if (fs.existsSync(donePath) || fs.existsSync(failedPath)) {
      throw new AppError('INSTRUCTION_ALREADY_FINAL', `指令 ${id} 已处于终态`, JSONRPC_ERRORS.INVALID_PARAMS, {
        instructionId: id,
        file: fs.existsSync(donePath) ? donePath : failedPath,
      });
    }

    // ---- 阶段一：确保记录位于 picked ----
    let record = null;
    if (fs.existsSync(pickedPath)) {
      record = this.readRecordFile(pickedPath);
    } else if (fs.existsSync(pendingPath)) {
      const pendingRecord = this.readRecordFile(pendingPath);
      if (pendingRecord && (pendingRecord.status === 'done' || pendingRecord.status === 'failed')) {
        throw new AppError('INSTRUCTION_ALREADY_FINAL', `指令 ${id} 已处于终态 ${pendingRecord.status}`, JSONRPC_ERRORS.INVALID_PARAMS, {
          instructionId: id,
          currentStatus: pendingRecord.status,
        });
      }
      const claim = this.claimWithContent(pendingPath, this.parts.picked, {
        ...pendingRecord,
        status: 'picked',
        pickedAt: pendingRecord.pickedAt || new Date().toISOString(),
      });
      if (claim.ok) {
        record = { ...pendingRecord, status: 'picked' };
      } else if (fs.existsSync(pickedPath)) {
        // 被并发取件者抢先放入 picked：以 picked 中的版本为准，继续阶段二。
        record = this.readRecordFile(pickedPath);
      } else if (fs.existsSync(donePath) || fs.existsSync(failedPath)) {
        throw new AppError('INSTRUCTION_ALREADY_FINAL', `指令 ${id} 已被并发完成`, JSONRPC_ERRORS.INVALID_PARAMS, {
          instructionId: id,
          reason: claim.reason,
        });
      } else {
        throw new AppError('INSTRUCTION_NOT_FOUND', `未找到指令 ${id}`, JSONRPC_ERRORS.INVALID_PARAMS, { instructionId: id });
      }
    } else {
      throw new AppError('INSTRUCTION_NOT_FOUND', `未找到指令 ${id}`, JSONRPC_ERRORS.INVALID_PARAMS, {
        instructionId: id,
      });
    }

    if (!record) {
      throw new AppError('INSTRUCTION_NOT_FOUND', `未找到指令 ${id}`, JSONRPC_ERRORS.INVALID_PARAMS, { instructionId: id });
    }
    if (record.status === 'done' || record.status === 'failed') {
      throw new AppError('INSTRUCTION_ALREADY_FINAL', `指令 ${id} 已处于终态 ${record.status}`, JSONRPC_ERRORS.INVALID_PARAMS, {
        instructionId: id,
        currentStatus: record.status,
      });
    }

    // ---- 阶段二：picked → done|failed ----
    const destDir = path.join(this.root, destDirName);
    const updated = {
      ...record,
      status: input.status,
      result: input.result === undefined ? null : input.result,
      completedAt: new Date().toISOString(),
    };
    const finalized = this.claimWithContent(pickedPath, destDir, updated);
    if (!finalized.ok) {
      // 【D11-2c 变体3 修复】GONE 语义不可过载：link(picked→done|failed) 的 ENOENT 既可能来自
      // 「已被并发完成」，也可能来自「picked 被并发回滚撤销」。必须**核验终态是否真实存在**：
      //   - 存在 → 真·已终态，报 INSTRUCTION_ALREADY_FINAL；
      //   - 不存在 → 记录并未完成（仍在源状态、会被再次投递），必须报**可重试**的并发错误，
      //     绝不报终态——否则调用方误信「已完成」而停止处理 → 记录被重复执行。
      if (fs.existsSync(donePath) || fs.existsSync(failedPath)) {
        throw new AppError('INSTRUCTION_ALREADY_FINAL', `指令 ${id} 已被并发完成`, JSONRPC_ERRORS.INVALID_PARAMS, {
          instructionId: id,
          reason: finalized.reason,
        });
      }
      throw new AppError(
        'INSTRUCTION_CLAIM_LOST',
        `并发冲突：指令 ${id} 的领取被并发回滚，记录未完成（可重试）`,
        JSONRPC_ERRORS.INTERNAL_ERROR,
        { instructionId: id, reason: finalized.reason },
      );
    }
    return updated;
  }

  /**
   * 统计各状态计数（**严格只读，零写入**）。
   *
   * 损坏记录不会被移动或删除，而是计入 `corrupt` / `corruptFiles` 并置 `corruptDetected=true`，
   * 避免把「数据损坏」静默等价为「正常空队列」（F05）。
   *
   * @return {Object} 统计结果。
   */
  stats() {
    const { byStatus, corrupt } = this.scanAll();
    const counts = { pending: 0, picked: 0, done: 0, failed: 0 };
    let oldestPendingAt = null;
    let latestCreatedAt = null;
    let total = 0;
    for (const status of STATUSES) {
      for (const item of byStatus[status]) {
        const record = item.record;
        counts[status] += 1;
        total += 1;
        if (status === 'pending' && (!oldestPendingAt || record.createdAt < oldestPendingAt)) {
          oldestPendingAt = record.createdAt;
        }
        if (typeof record.createdAt === 'string' && (!latestCreatedAt || record.createdAt > latestCreatedAt)) {
          latestCreatedAt = record.createdAt;
        }
      }
    }
    let storeExists = false;
    try {
      storeExists = fs.statSync(this.root).isDirectory();
    } catch (_error) {
      storeExists = false;
    }
    return {
      storeRoot: this.root,
      storeVersion: STORE_VERSION,
      storeExists,
      total,
      counts,
      oldestPendingAt,
      latestCreatedAt,
      corruptDetected: corrupt.length > 0,
      corrupt: corrupt.length,
      corruptFiles: corrupt.slice(0, 50),
      pending: counts.pending,
      picked: counts.picked,
      done: counts.done,
      failed: counts.failed,
    };
  }
}

module.exports = {
  STORE_VERSION,
  RECORD_SUFFIX,
  TMP_SUFFIX,
  STATUSES,
  STATUS_TO_DIR,
  PRIORITIES,
  RENAME_RETRY,
  CRITICAL_SECTION_BUDGET_MS,
  MAX_TRANSITIONS_PER_OPERATION,
  QUEUE_OPERATION_BUDGET_MS,
  STORE_OPERATION_DEADLINE_MS,
  InstructionStore,
  compareForPick,
  renameWithRetry,
  claimLink,
  removeSourceLink,
  backoffDelay,
  worstCaseDelayMs,
  totalBackoffBudget,
  assertBudgetInvariant,
  sleepSync,
};
