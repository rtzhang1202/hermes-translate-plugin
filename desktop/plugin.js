/**
 * hermes-translate v4 — DUAL-SPEED EN→zh translation for the Hermes Desktop
 * "技能与工具" (Capabilities) page.
 *
 * ⚡ 快译 button  — Google Translate / MyMemory machine translation, seconds.
 *                   Also kicks off background LLM refinement of every string.
 * ✦ 精译 button  — swap the displayed text to the LLM-refined version
 *                   (falls back to the fast version where the LLM hasn't
 *                   finished yet).
 *
 * Progress: the ⚡ chip shows `done/total` for the current page — you can tell
 * "still translating" (total climbing) from "stuck" (done frozen).
 *
 * Scope: /capabilities route only; chat, sidebar, status bar, code and inputs
 * are never touched (exact data-slot / ARIA-role protections — never bare tag
 * names, see 注意事项.md).
 *
 * Backend: %HERMES_HOME%/plugins/hermes-translate/dashboard/plugin_api.py
 *   POST /fast-translate   fast MT   (provider switchable via /config)
 *   POST /translate        LLM tier  (ordered-array protocol)
 */

import { atom, cn, host, PALETTE_AREA, STATUSBAR_AREAS, Tip, useValue } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'

const ID = 'hermes-translate'

/** Instant label translations — applied whole-node before any network call. */
const SEED_DICT = {
  Skills: '技能',
  Skill: '技能',
  Toolsets: '工具集',
  Toolset: '工具集',
  Tools: '工具',
  Tool: '工具',
  Plugins: '插件',
  Plugin: '插件',
  Capabilities: '能力',
  Description: '描述',
  Category: '分类',
  Tags: '标签',
  Usage: '使用',
  Enabled: '已启用',
  Disabled: '已停用',
  Enable: '启用',
  Disable: '停用',
  Install: '安装',
  Uninstall: '卸载',
  Update: '更新',
  Official: '官方',
  Hub: '技能中心',
  Installed: '已安装',
  Learned: '习得',
  Search: '搜索',
  Name: '名称',
  Version: '版本',
  Author: '作者',
  License: '许可',
  Details: '详情',
  Overview: '概览',
  Examples: '示例',
  'See all': '查看全部',
  'Learn more': '了解更多',
  'No results': '无结果',
  Loading: '加载中',
  'Created by agent': '由 Agent 创建',
  Bundled: '内置',
  'Related skills': '相关技能',
  Troubleshooting: '故障排查',
  Prerequisites: '前置条件',
  Verification: '验证',
  Procedure: '操作步骤',
  Pitfalls: '注意事项',
  Desktop: '桌面',
  Agent: '智能体',
  Hosted: '托管',
  Local: '本地',
  Portable: '便携',
  'Built-in': '内置'
}

/** Never translate: code, inputs, chat, and app chrome identified by exact
 *  data-slots / ARIA roles. Bare tag names (nav/aside/header) are FORBIDDEN
 *  here — MasterDetail wraps list rails in <aside> and headers in <header>. */
const PROTECTED_SEL = [
  'pre', 'code', 'kbd', 'textarea', 'input', 'script', 'style',
  '[data-slot="sidebar"]', '[data-slot="statusbar"]', '[data-slot^="aui_"]',
  '[data-slot^="composer"]', '[data-slot="tool-block"]', '[data-slot="code-card"]',
  '[data-slot="thread-timeline"]',
  '[role="banner"]', '[role="navigation"]',
  '[data-message-id]', '[data-role]', '[data-composer-target]'
].join(', ')

const enabledAtom = atom(false)
const modeAtom = atom('fast') // 'fast' | 'llm'
const progressAtom = atom({ done: 0, total: 0 })

const state = {
  ctx: null,
  enabled: false,
  mode: 'fast',
  fastDict: new Map(Object.entries(SEED_DICT)),
  llmDict: new Map(),
  originals: new WeakMap(), // Text node -> original nodeValue
  seen: new Set(),
  fastPending: new Set(),
  llmPending: new Set(),
  fastAttempts: new Map(),
  llmAttempts: new Map(),
  pendingNodes: [], // [node, trimmed] awaiting a translation — applied incrementally
  queuedNodes: new WeakSet(),
  fastTimer: null,
  llmTimer: null,
  observer: null,
  backendOk: null,
  engine: '',
  errors: [],
  lastNotify: 0
}

function notify(kind, message, minGapMs = 0) {
  const now = Date.now()
  if (minGapMs && now - state.lastNotify < minGapMs) return
  state.lastNotify = now
  try {
    host.notify({ kind, message })
  } catch { /* best-effort */ }
}

/** REST pinned to THIS machine (an untagged request can be hijacked by a
 *  remote registry primary — see api/client.ts capabilityScoped notes). */
function restCall(path, opts = {}) {
  const bridge = window.hermesDesktop
  if (bridge && typeof bridge.api === 'function') {
    const req = {
      connectionId: 'local',
      path: '/api/plugins/hermes-translate' + path,
      method: opts.method || 'GET',
      timeoutMs: opts.timeoutMs || 60000
    }
    if (opts.body !== undefined) req.body = opts.body
    try {
      const p = host.state.profile && host.state.profile.get && host.state.profile.get()
      if (typeof p === 'string' && p) req.profile = p
    } catch { /* optional */ }
    return bridge.api(req)
  }
  return state.ctx.rest(path, opts)
}

function onCapabilitiesPage() {
  const loc = window.location
  const p = ((loc && loc.pathname) || '') + ((loc && loc.hash) || '')
  return p.includes('/capabilities')
}

function isAllowed(el) {
  if (!el || !el.closest) return false
  if (!onCapabilitiesPage()) return false
  return !el.closest(PROTECTED_SEL)
}

function looksTranslatable(text) {
  if (text.length < 3 || text.length > 3000) return false
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length
  if (cjk / text.length > 0.6) return false // mostly Chinese already
  if (!/\s/.test(text)) return false // single token: identifier — dict-only
  const letters = (text.match(/[A-Za-z]/g) || []).length
  if (letters < 2) return false
  if (letters / text.length < 0.35) return false
  // code chars are DENSITY-based now: prose mentioning `memory_save`,
  // "tool; the colour" or a URL must survive; only real code dies
  const code = (text.match(/[{}[\]<>|;=`_$\\~^]/g) || []).length
  if (code / text.length > 0.06) return false
  return true
}

function lookup(trimmed) {
  const fast = state.fastDict.get(trimmed)
  const llm = state.llmDict.get(trimmed)
  return state.mode === 'llm' ? (llm || fast) : (fast || llm)
}

function updateProgress() {
  let done = 0
  for (const s of state.seen) if (lookup(s)) done++
  const busy = state.fastPending.size + state.llmPending.size > 0
  progressAtom.set({ done, total: state.seen.size, busy })
}

function replaceWholeNode(node, trimmed, translated) {
  const text = node.nodeValue
  const i = text.indexOf(trimmed)
  if (i < 0) return
  if (!state.originals.has(node)) state.originals.set(node, text)
  node.nodeValue = text.slice(0, i) + translated + text.slice(i + trimmed.length)
}

/** Re-render OUR node under the current display mode (fast ⇄ LLM). */
function applyMode(node) {
  const orig = state.originals.get(node)
  if (orig == null) return
  const trimmed = orig.trim()
  const t = lookup(trimmed)
  if (t && t !== trimmed) {
    const i = orig.indexOf(trimmed)
    const next = orig.slice(0, i) + t + orig.slice(i + trimmed.length)
    if (next !== node.nodeValue) node.nodeValue = next
  }
}

function translateTextNode(node) {
  if (state.originals.has(node)) {
    const orig = state.originals.get(node)
    if (node.nodeValue !== orig) {
      applyMode(node) // ours — refresh against the current display mode
      return
    }
    state.originals.delete(node) // React restored English — reprocess below
  }
  const text = node.nodeValue
  if (!text || text.trim().length < 2) return
  const el = node.parentElement
  if (!el || !isAllowed(el)) return
  const trimmed = text.trim()
  const hit = lookup(trimmed)
  if (hit && hit !== trimmed) {
    state.seen.add(trimmed)
    replaceWholeNode(node, trimmed, hit)
    updateProgress()
    return
  }
  if (/[\u4e00-\u9fff\u3040-\u30ff]/.test(trimmed)) return
  if (!looksTranslatable(trimmed)) return
  // only count REAL candidates — identifiers / labels / CJK chrome must not
  // inflate the progress total or the counter looks stuck forever
  state.seen.add(trimmed)
  if (!state.fastPending.has(trimmed) && (state.fastAttempts.get(trimmed) || 0) < 3) {
    state.fastPending.add(trimmed)
    scheduleFast()
  }
  if (!state.llmPending.has(trimmed) && (state.llmAttempts.get(trimmed) || 0) < 3) {
    state.llmPending.add(trimmed)
    scheduleLlm()
  }
  if (!state.queuedNodes.has(node)) {
    state.queuedNodes.add(node)
    state.pendingNodes.push([node, trimmed])
  }
  updateProgress()
}

/** Apply arrived translations to the queued nodes only — O(pending), so it is
 *  safe to run after every probe/flush. Without this, dict entries loaded at
 *  probe time never reach the screen until the page remounts (the exact
 *  "switch away and back" symptom). */
function applyPending() {
  if (!state.pendingNodes.length) return
  const keep = []
  for (const [node, trimmed] of state.pendingNodes) {
    if (!node.isConnected) {
      state.queuedNodes.delete(node)
      continue
    }
    const t = lookup(trimmed)
    if (t && t !== trimmed && node.nodeValue && node.nodeValue.includes(trimmed)) {
      replaceWholeNode(node, trimmed, t)
      state.queuedNodes.delete(node)
      continue
    }
    if (t && node.nodeValue && !node.nodeValue.includes(trimmed)) {
      state.queuedNodes.delete(node) // stale — text changed, observer re-collects
      continue
    }
    keep.push([node, trimmed])
  }
  state.pendingNodes = keep
  updateProgress()
}

function sweep(root) {
  if (!state.enabled || !root) return
  if (root.nodeType === 3) {
    translateTextNode(root)
    return
  }
  if (root.nodeType !== 1) return
  const doc = root.ownerDocument || document
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
  const nodes = []
  let n
  while ((n = walker.nextNode())) nodes.push(n)
  for (const t of nodes) translateTextNode(t)
}

/** Mode switch: re-render every node we own, then sweep for leftovers. */
function setMode(mode) {
  state.mode = mode
  modeAtom.set(mode)
  if (!state.enabled) {
    state.enabled = true
    enabledAtom.set(true)
    probeBackend()
  }
  sweep(document.body)
  notify('info', mode === 'llm'
    ? '已切换到 ✦ 精译（LLM 版本；未完成处暂用快译兜底）'
    : '已切换到 ⚡ 快译（机器翻译版本）', 0)
}

function setEnabled(on) {
  state.enabled = on
  enabledAtom.set(on)
  if (on) {
    probeBackend()
    sweep(document.body)
    notify('success', '⚡ 快译已开启 — 秒级出翻译，LLM 在后台润色', 0)
  } else {
    notify('info', '界面翻译已暂停', 0)
  }
}

// ── fast tier ────────────────────────────────────────────────────────────────

function scheduleFast() {
  if (state.fastTimer) return
  state.fastTimer = state.ctx.setTimeout(() => {
    state.fastTimer = null
    flushFast()
  }, 400)
}

async function flushFast() {
  const all = [...state.fastPending]
  state.fastPending.clear()
  if (!all.length) return
  const strings = all.slice(0, 30)
  const leftover = all.slice(30)
  try {
    const res = await restCall('/fast-translate', {
      method: 'POST',
      body: { strings },
      timeoutMs: 60000
    })
    const t = res && typeof res === 'object' ? res.translations : null
    if (!t || typeof t !== 'object') throw new Error('bad response: ' + JSON.stringify(res).slice(0, 100))
    let added = 0
    for (const [en, zh] of Object.entries(t)) {
      if (typeof zh === 'string' && zh) {
        if (!state.fastDict.has(en)) added++
        state.fastDict.set(en, zh)
      }
    }
    if (res.engine) state.engine = res.engine
    state.backendOk = true
    for (const s of strings) {
      if (!state.fastDict.has(s)) {
        const a = (state.fastAttempts.get(s) || 0) + 1
        state.fastAttempts.set(s, a)
        if (a < 3) state.fastPending.add(s)
      }
    }
    if (added) {
      for (const k of state.fastAttempts.keys()) {
        state.fastAttempts.set(k, Math.max(0, (state.fastAttempts.get(k) || 0) - 1))
      }
      applyPending()
      const p = progressAtom.get()
      notify('success', `⚡ 快译 +${added}（${p.done}/${p.total}）· 引擎 ${state.engine}`, 2500)
    }
  } catch (e) {
    const msg = (e && e.message) || String(e)
    state.errors.push(msg)
    if (state.errors.length > 5) state.errors.shift()
    notify('error', `快译失败：${msg}`, 30000)
    for (const s of strings) {
      const a = (state.fastAttempts.get(s) || 0) + 1
      state.fastAttempts.set(s, a)
      if (a < 3) state.fastPending.add(s)
    }
  }
  if (leftover.length) for (const s of leftover) state.fastPending.add(s)
  if (state.fastPending.size) scheduleFast()
}

// ── LLM tier (background refinement) ────────────────────────────────────────

function scheduleLlm() {
  if (state.llmTimer) return
  state.llmTimer = state.ctx.setTimeout(() => {
    state.llmTimer = null
    flushLlm()
  }, 700)
}

async function flushLlm() {
  const all = [...state.llmPending]
  state.llmPending.clear()
  if (!all.length) return
  // 3 batches in parallel — long (>600 char) strings only travel this tier,
  // serial single batches made whole pages wait 10+ minutes
  const batches = []
  while (all.length && batches.length < 3) batches.push(all.splice(0, 12))
  if (all.length) for (const s of all) state.llmPending.add(s)
  const settled = await Promise.allSettled(batches.map(strings =>
    restCall('/translate', { method: 'POST', body: { strings }, timeoutMs: 300000 })
  ))
  let added = 0
  for (let i = 0; i < settled.length; i++) {
    const strings = batches[i]
    const r = settled[i]
    let t = null
    if (r.status === 'fulfilled') {
      const res = r.value
      t = res && typeof res === 'object' ? res.translations : null
    }
    if (!t || typeof t !== 'object') {
      const msg = r.status === 'rejected'
        ? ((r.reason && r.reason.message) || String(r.reason))
        : ('bad response: ' + JSON.stringify(r.value).slice(0, 100))
      state.errors.push(msg)
      if (state.errors.length > 5) state.errors.shift()
      notify('error', `LLM 润色失败：${msg}`, 60000)
      for (const s of strings) {
        const a = (state.llmAttempts.get(s) || 0) + 1
        state.llmAttempts.set(s, a)
        if (a < 3) state.llmPending.add(s)
      }
      continue
    }
    for (const [en, zh] of Object.entries(t)) {
      if (typeof zh === 'string' && zh) {
        if (!state.llmDict.has(en)) added++
        state.llmDict.set(en, zh)
      }
    }
    state.backendOk = true
    for (const s of strings) {
      if (!state.llmDict.has(s)) {
        const a = (state.llmAttempts.get(s) || 0) + 1
        state.llmAttempts.set(s, a)
        if (a < 3) state.llmPending.add(s)
      }
    }
  }
  if (added) {
    for (const k of state.llmAttempts.keys()) {
      state.llmAttempts.set(k, Math.max(0, (state.llmAttempts.get(k) || 0) - 1))
    }
    // ALWAYS apply: LLM entries also serve as the FALLBACK in fast mode
    applyPending()
  }
  if (state.llmPending.size) scheduleLlm()
}

// ── backend probe & engine switching ────────────────────────────────────────

async function probeBackend() {
  try {
    const res = await restCall('/dict', { timeoutMs: 60000 })
    const llm = res && typeof res === 'object' ? res.translations : null
    const fast = res && typeof res === 'object' ? res.fast : null
    if (!llm || typeof llm !== 'object') throw new Error('bad /dict response')
    for (const [en, zh] of Object.entries(llm)) {
      if (typeof zh === 'string' && zh) state.llmDict.set(en, zh)
    }
    for (const [en, zh] of Object.entries(fast || {})) {
      if (typeof zh === 'string' && zh && !state.fastDict.has(en)) state.fastDict.set(en, zh)
    }
    state.backendOk = true
    try {
      const cfg = await restCall('/config', { timeoutMs: 10000 })
      if (cfg && cfg.fast_provider) state.engine = cfg.fast_provider
    } catch { /* engine label is cosmetic */ }
    // apply everything the dictionaries already hold to queued nodes —
    // without this the page stays English until a remount (switch away/back)
    applyPending()
    updateProgress()
    notify('success', `翻译后端已连接 ✓ 快译引擎 ${state.engine || 'google'} · 词典 快${state.fastDict.size}/精${state.llmDict.size}`, 0)
  } catch (e) {
    state.backendOk = false
    const msg = (e && e.message) || String(e)
    state.errors.push(msg)
    notify('error', `翻译后端不可用：${msg}`, 0)
  }
}

async function cycleEngine() {
  try {
    const cfg = await restCall('/config', { timeoutMs: 10000 })
    const list = (cfg && cfg.providers) || ['google', 'mymemory']
    const next = list[(list.indexOf(cfg.fast_provider) + 1) % list.length]
    await restCall('/config', { method: 'POST', body: { fast_provider: next }, timeoutMs: 10000 })
    state.engine = next
    notify('success', `快译引擎已切换为：${next}${next === 'google' ? '（需代理，译文较自然）' : '（中国大陆直连可用）'}`, 0)
    state.fastAttempts.clear()
  } catch (e) {
    notify('error', `引擎切换失败：${(e && e.message) || e}`, 0)
  }
}

// ── UI ───────────────────────────────────────────────────────────────────────

function FastChip() {
  const on = useValue(enabledAtom)
  const p = useValue(progressAtom)
  const stalled = on && !p.busy && p.done < p.total
  return jsx(Tip, {
    label: on
      ? `⚡ 快译：${p.done}/${p.total}${stalled ? `（${p.total - p.done} 条暂未成功 — 可 ⌘K 重扫或切换引擎）` : '（运行中）'} — 点击暂停`
      : '⚡ 点击开启快译（机器翻译秒出，LLM 后台润色）',
    children: jsx('button', {
      type: 'button',
      onClick: () => setEnabled(!enabledAtom.get()),
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
        on ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      children: on ? `⚡ ${p.done}/${p.total}${stalled ? ' ✗' : ''}` : '⚡ 快译'
    })
  })
}

function LlmChip() {
  const mode = useValue(modeAtom)
  const on = useValue(enabledAtom)
  const active = on && mode === 'llm'
  return jsx(Tip, {
    label: active
      ? '✦ 精译显示中（LLM 版本）— 点击切回快译'
      : '✦ 点击切换为精译（LLM 润色版本，后台自动完善）',
    children: jsx('button', {
      type: 'button',
      onClick: () => setMode(state.mode === 'llm' ? 'fast' : 'llm'),
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
        active ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      children: active ? '✦ 精译 ON' : '✦ 精译'
    })
  })
}

function statsLine() {
  const p = progressAtom.get()
  const err = state.errors.length ? ' | ' + state.errors[state.errors.length - 1].slice(0, 50) : ''
  return `进度 ${p.done}/${p.total} | 快译词典 ${state.fastDict.size} | 精译词典 ${state.llmDict.size} | 引擎 ${state.engine || '?'} | 后端 ${state.backendOk === null ? '未知' : state.backendOk ? 'OK' : '异常'}${err}`
}

export default {
  id: ID,
  name: '界面翻译',
  register(ctx) {
    state.ctx = ctx

    ctx.register({
      id: 'fast-chip',
      area: STATUSBAR_AREAS.right,
      order: 500,
      render: () => jsx(FastChip, {})
    })
    ctx.register({
      id: 'llm-chip',
      area: STATUSBAR_AREAS.right,
      order: 501,
      render: () => jsx(LlmChip, {})
    })

    ctx.registerMany([
      {
        id: 'toggle',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-translate.toggle',
          label: '界面翻译: ⚡ 快译 开启 / 暂停',
          keywords: ['translate', '翻译', 'fast', '快译'],
          run: () => setEnabled(!enabledAtom.get())
        }
      },
      {
        id: 'mode',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-translate.mode',
          label: '界面翻译: ✦ 切换 快译 / 精译 显示版本',
          keywords: ['llm', '精译', 'mode'],
          run: () => setMode(state.mode === 'llm' ? 'fast' : 'llm')
        }
      },
      {
        id: 'engine',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-translate.engine',
          label: '界面翻译: 切换快译引擎（google / mymemory）',
          keywords: ['engine', '引擎', 'google'],
          run: () => cycleEngine()
        }
      },
      {
        id: 'rescan',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-translate.rescan',
          label: '界面翻译: 重新扫描 + 状态报告',
          keywords: ['rescan', '扫描', 'stats', '统计'],
          run: () => {
            sweep(document.body)
            updateProgress()
            notify('info', statsLine(), 0)
          }
        }
      },
      {
        id: 'debug',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-translate.debug',
          label: '界面翻译: 调试 — 收集并翻译本页',
          keywords: ['debug', '调试'],
          run: () => {
            if (!state.enabled) setEnabled(true)
            sweep(document.body)
            updateProgress()
            notify('info', `调试：页面=${onCapabilitiesPage() ? '技能与工具 ✓' : '非技能与工具页 ✗'} | ${statsLine()}`, 0)
            flushFast()
            flushLlm()
          }
        }
      },
      {
        id: 'restart-gateway',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-translate.restartGateway',
          label: '界面翻译: 重启网关（挂载翻译后端）',
          keywords: ['restart', 'gateway', '重启', '网关'],
          run: () => {
            host.restartGateway()
            host.notify({ kind: 'info', message: '网关重启中 — 桌面将自动重连' })
          }
        }
      }
    ])

    state.observer = new MutationObserver(muts => {
      if (!state.enabled) return
      for (const m of muts) {
        if (m.type === 'characterData') {
          translateTextNode(m.target)
        } else {
          for (const node of m.addedNodes) {
            if (node.nodeType === 3) translateTextNode(node)
            else if (node.nodeType === 1) sweep(node)
          }
        }
      }
    })
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    ctx.onDispose(() => {
      if (state.observer) state.observer.disconnect()
      state.observer = null
    })
  }
}
