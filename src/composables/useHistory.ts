import { ref, watch } from 'vue'
import { usePluginSettings } from './usePluginSettings'

/**
 * 历史记录单例：跨组件共享同一份历史列表。
 *
 * - Recognize / Translate 完成识别/翻译后，由 Manage 调用 pushHistory 写入。
 * - HistoryView 读取 historyList 渲染左侧缩略列表与右侧详情面板。
 * - 持久化到 window.ztools.dbStorage（key: `history.list`）。
 * - 条数上限与存留天数取自插件设置（usePluginSettings，设置页可改）：
 *   默认 100 条 + 永久保留，即引入设置页之前的行为。
 *
 * 与 useNativeEngine 同构的「模块级单例」模式：切 tab 卸载组件时数据不丢，
 * 重新挂载仍读到同一份列表。
 */

/** dbStorage 中存储历史记录的 key。 */
const STORAGE_KEY = 'history.list'

/** 一天的毫秒数（存留天数换算）。 */
const DAY_MS = 24 * 60 * 60 * 1000

// 设置单例：条数上限 / 存留天数，改动即时生效（见下方 watch）
const { settings } = usePluginSettings()

// ─── 模块级单例（进程内唯一，跨组件共享）────────────────────────────────
const historyList = ref<HistoryItem[]>([])

/**
 * 是否已完成首次载入。
 *
 * 历史记录单例是模块级 ref，进程内始终存活，无需每次 Manage 重新挂载都重读
 * dbStorage。更关键的是：若在 pushHistory（写入内存 + 触发异步写盘）之后
 * Manage 被卸载重建触发 loadHistory，会用 dbStorage 里的旧快照覆盖内存中
 * 刚写入的新记录，导致历史丢失。故 loadHistory 只在模块首次加载时执行一次，
 * 后续重复调用直接跳过。
 */
let loaded = false

/**
 * 按当前设置裁剪列表：先剔除超过存留天数的记录，再截断到条数上限。
 * 列表按时间倒序，故截断即淘汰最旧的。
 * @returns 是否发生了裁剪（调用方据此决定要不要落盘）。
 */
function prune(): boolean {
  const list = historyList.value
  const days = settings.historyRetentionDays
  const cutoff = days > 0 ? Date.now() - days * DAY_MS : 0
  const kept = (cutoff ? list.filter((it) => it.ts >= cutoff) : list).slice(
    0,
    Math.max(1, settings.historyMaxItems)
  )
  if (kept.length === list.length) return false
  historyList.value = kept
  return true
}

/** 应用历史记录策略（条数 + 存留天数），有裁剪则同步落盘。 */
function applyHistoryPolicies(): void {
  // 幂等：首次调用顺带完成载入，保证裁剪基于已落盘的数据
  loadHistory()
  if (prune()) persist()
}

/** 从 dbStorage 载入历史记录到单例 ref。仅在模块首次加载时执行一次。 */
function loadHistory(): void {
  if (loaded) return
  loaded = true
  try {
    const stored = window.ztools.dbStorage.getItem<HistoryItem[]>(STORAGE_KEY)
    historyList.value = Array.isArray(stored) ? stored : []
  } catch (e) {
    // dbStorage 不可用等异常：保持空列表，不阻塞 UI；记录原因便于排查
    console.warn('[useHistory] loadHistory 读取 dbStorage 失败:', e)
    historyList.value = []
  }
  // 载入即按当前设置清理一次（存留天数 / 条数上限可能在上次退出后被调小）
  if (prune()) persist()
}

/** 同步当前单例列表到 dbStorage。 */
function persist(): void {
  try {
    // historyList 是 ref，读出的 value 及嵌套元素是 Vue 响应式 Proxy；
    // dbStorage.setItem 底层走 Electron 同步 IPC 的结构化克隆，无法克隆 Proxy，
    // 会抛 "An object could not be cloned" 导致历史记录丢失。
    // 这里经 JSON 序列化一次，剥离 Proxy 得到纯数据再写入。
    const plain = JSON.parse(JSON.stringify(historyList.value))
    window.ztools.dbStorage.setItem(STORAGE_KEY, plain)
  } catch (e) {
    // 写入失败不阻塞 UI，但输出告警：便于排查（如 OCR data URI 过大触发写盘失败）
    console.warn('[useHistory] persist 写入 dbStorage 失败:', e)
  }
}

/**
 * 新增一条历史记录：unshift 到头部，按设置裁剪（条数上限 / 存留天数）后同步到 dbStorage。
 * @param item 不含 id / ts 的条目，由本函数补全。
 */
function pushHistory(item: HistoryEmitItem): void {
  const full: HistoryItem = {
    ...item,
    id:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10),
    ts: Date.now()
  }
  historyList.value.unshift(full)
  prune()
  persist()
}

/** 删除指定 id 的历史记录。 */
function removeHistory(id: string): void {
  historyList.value = historyList.value.filter((it) => it.id !== id)
  persist()
}

/** 清空全部历史记录。 */
function clearHistory(): void {
  historyList.value = []
  persist()
}

// 设置页改动条数上限 / 存留天数后立即裁剪：无需重进页面，当前列表即时收敛
watch(
  () => [settings.historyMaxItems, settings.historyRetentionDays],
  () => applyHistoryPolicies()
)

export function useHistory() {
  return {
    historyList,
    loadHistory,
    pushHistory,
    removeHistory,
    clearHistory
  }
}
