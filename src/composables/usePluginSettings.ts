import { reactive } from 'vue'

/**
 * 插件行为设置单例：跨组件共享同一份设置对象。
 *
 * - 设置页（views/Settings.vue）读写本单例，改动即时保存到
 *   window.ztools.dbStorage（key: `plugin.settings`）。
 * - SettingLayout（底部导航常驻）、Recognize（OCR 结果聚合段落）、
 *   useHistory（条数上限 / 存留天数）直接读本单例，改设置立即生效，无需重启插件。
 *
 * 与 useHistory 同构的「模块级单例」模式。dbStorage 为同步 API，故在模块加载时
 * 立即回填：任何组件首次渲染即拿到持久化后的值，不会先闪一帧默认值。
 */

/** dbStorage 中存储插件行为设置的 key。 */
const STORAGE_KEY = 'plugin.settings'

/** 历史条数设置的下限（0 会让历史记录不可用，故至少 1 条）。 */
export const HISTORY_MAX_ITEMS_MIN = 1

/** 历史条数设置的上限（避免超大列表拖慢渲染与写盘）。 */
export const HISTORY_MAX_ITEMS_MAX = 5000

/** 历史存留天数可选项；value = 0 表示永久保留。 */
export const HISTORY_RETENTION_OPTIONS: { label: string; value: number }[] = [
  { label: '永久保留', value: 0 },
  { label: '7 天', value: 7 },
  { label: '30 天', value: 30 },
  { label: '90 天', value: 90 },
  { label: '180 天', value: 180 },
  { label: '365 天', value: 365 }
]

/** 默认设置（保持引入本设置页之前的行为）：导航栏自动隐藏、聚合段落开启、100 条、永久保留。 */
export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
  dockAlwaysVisible: false,
  ocrMergeParagraphs: true,
  historyMaxItems: 100,
  historyRetentionDays: 0
}

/** 设置单例：全局唯一，读写同一对象，改动对所有读取方即时可见。 */
const settings = reactive<PluginSettings>({ ...DEFAULT_PLUGIN_SETTINGS })

/**
 * 把历史条数夹到合法范围。
 * @param value    待校验值（可能来自输入框，为字符串 / NaN）。
 * @param fallback 非法时回落的值（默认 100）。
 * @returns 合法整数条数。
 */
export function clampHistoryMaxItems(
  value: unknown,
  fallback: number = DEFAULT_PLUGIN_SETTINGS.historyMaxItems
): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, HISTORY_MAX_ITEMS_MIN), HISTORY_MAX_ITEMS_MAX)
}

/** 存留天数：仅接受 >= 0 的整数（0 = 永久），非法输入回落默认值。 */
function normalizeRetentionDays(value: unknown): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PLUGIN_SETTINGS.historyRetentionDays
  return n
}

/**
 * 按默认值兜底地归一化一份原始设置：缺字段 / 字段类型不对（旧版本数据、
 * 手工改过的 dbStorage）都回落默认值，避免把坏数据灌进单例。
 */
function normalize(raw: unknown): PluginSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<PluginSettings>
  return {
    dockAlwaysVisible:
      typeof r.dockAlwaysVisible === 'boolean'
        ? r.dockAlwaysVisible
        : DEFAULT_PLUGIN_SETTINGS.dockAlwaysVisible,
    ocrMergeParagraphs:
      typeof r.ocrMergeParagraphs === 'boolean'
        ? r.ocrMergeParagraphs
        : DEFAULT_PLUGIN_SETTINGS.ocrMergeParagraphs,
    historyMaxItems: clampHistoryMaxItems(r.historyMaxItems),
    historyRetentionDays: normalizeRetentionDays(r.historyRetentionDays)
  }
}

/** 从 dbStorage 读取设置并回填单例。模块加载时执行一次（dbStorage 不可用时保持默认值）。 */
function loadPluginSettings(): void {
  try {
    Object.assign(settings, normalize(window.ztools.dbStorage.getItem(STORAGE_KEY)))
  } catch (e) {
    console.warn('[usePluginSettings] 读取 dbStorage 失败，改用默认设置:', e)
    Object.assign(settings, DEFAULT_PLUGIN_SETTINGS)
  }
}

/**
 * 保存当前设置为设置单例的现值并落盘。
 * 经 JSON 序列化剥离 reactive Proxy：dbStorage 底层走 Electron 同步 IPC 的
 * 结构化克隆，无法克隆 Proxy（与 useHistory.persist 同因）。
 */
export function saveSettings(): void {
  try {
    window.ztools.dbStorage.setItem(STORAGE_KEY, JSON.parse(JSON.stringify(settings)))
  } catch (e) {
    console.warn('[usePluginSettings] 写入 dbStorage 失败:', e)
  }
}

/** 恢复默认设置并落盘。 */
export function resetSettings(): void {
  Object.assign(settings, DEFAULT_PLUGIN_SETTINGS)
  saveSettings()
}

// 模块加载即回填，保证首个渲染的组件读到的是持久化后的值
loadPluginSettings()

export function usePluginSettings() {
  return {
    settings,
    saveSettings,
    resetSettings
  }
}
