<script setup lang="ts">
import { ref } from 'vue'
import { ZButton, ZInput, ZSelect, ZSwitch, useConfirmDialog, useToast } from 'ztools-ui'
import {
  clampHistoryMaxItems,
  HISTORY_RETENTION_OPTIONS,
  usePluginSettings
} from '../composables/usePluginSettings'
import { useHistory } from '../composables/useHistory'

/**
 * 设置页（插件行为偏好）：与「渠道」（引擎 / 翻译服务及其凭据）无关，
 * 这里只放插件自身的行为开关，改动即时保存到 dbStorage 并立即生效——
 * 各设置项由读取方直接订阅 usePluginSettings 单例，无需重启插件或重进页面。
 */

const { settings, saveSettings, resetSettings } = usePluginSettings()
const { historyList, clearHistory } = useHistory()
const { success } = useToast()
const { confirm } = useConfirmDialog()

/**
 * 历史条数输入框的本地文本：不直接绑 settings.historyMaxItems，
 * 否则输入中途的空串 / 半截数字会被立刻夹取，导致光标跳动、无法正常改数。
 * 只在 change（失焦 / 回车）时提交并回写规范化后的值。
 */
const maxItemsText = ref<string | number>(String(settings.historyMaxItems))

/** 提交历史条数：夹到合法范围，非法输入回落当前生效值；有变化才落盘。 */
function commitMaxItems(): void {
  const next = clampHistoryMaxItems(maxItemsText.value, settings.historyMaxItems)
  maxItemsText.value = String(next)
  if (next === settings.historyMaxItems) return
  settings.historyMaxItems = next
  saveSettings()
  success(`最多保留 ${next} 条记录`)
}

/**
 * 提交存留天数：ZSelect 的值类型为 string | number | null，统一转成数字；
 * 非法 / 空值按 0（永久保留）处理。
 */
function commitRetentionDays(value: unknown): void {
  const days = Math.round(Number(value))
  const next = Number.isFinite(days) && days > 0 ? days : 0
  if (next === settings.historyRetentionDays) return
  settings.historyRetentionDays = next
  saveSettings()
  success(next > 0 ? `记录最多存留 ${next} 天` : '记录永久保留')
}

/** 清空全部历史记录：不可恢复，先确认。 */
async function onClearHistory(): Promise<void> {
  const total = historyList.value.length
  if (!total) return
  const ok = await confirm({
    title: '清空历史记录',
    message: `将删除全部 ${total} 条记录，且不可恢复。`,
    type: 'danger',
    confirmText: '清空'
  })
  if (!ok) return
  clearHistory()
  success('已清空历史记录')
}

/** 恢复默认设置（含历史条数输入框回填）并提示。 */
function onReset(): void {
  resetSettings()
  maxItemsText.value = String(settings.historyMaxItems)
  success('已恢复默认设置')
}
</script>

<template>
  <div class="settings">
    <div class="settings-body">
      <header class="page-head">
        <h2 class="page-title">设置</h2>
        <ZButton size="small" type="text" @click="onReset">恢复默认</ZButton>
      </header>

      <section class="group">
        <div class="group-title">通用</div>
        <div class="group-card">
          <div class="row">
            <span class="row-label">底部导航栏常驻</span>
            <ZSwitch v-model="settings.dockAlwaysVisible" @change="saveSettings" />
          </div>
        </div>
      </section>

      <section class="group">
        <div class="group-title">识别</div>
        <div class="group-card">
          <div class="row">
            <span class="row-label">聚合段落</span>
            <ZSwitch v-model="settings.ocrMergeParagraphs" @change="saveSettings" />
          </div>
        </div>
      </section>

      <section class="group">
        <div class="group-title">历史记录</div>
        <div class="group-card">
          <div class="row row-num">
            <span class="row-label">最大记录数量</span>
            <ZInput
              v-model="maxItemsText"
              type="number"
              size="small"
              @change="commitMaxItems"
              @blur="commitMaxItems"
              @keydown.enter="commitMaxItems"
            />
          </div>
          <div class="row row-retention">
            <span class="row-label">存留时间</span>
            <ZSelect
              :model-value="settings.historyRetentionDays"
              :options="HISTORY_RETENTION_OPTIONS"
              size="small"
              @update:model-value="commitRetentionDays"
            />
          </div>
          <div class="row row-foot">
            <span class="foot-count">当前 {{ historyList.length }} 条记录</span>
            <ZButton size="small" type="text" :disabled="!historyList.length" @click="onClearHistory">
              清空历史
            </ZButton>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings {
  padding: 24px 28px 40px;
  box-sizing: border-box;
}

/* 居中窄栏：行式设置不需要占满整窗 */
.settings-body {
  max-width: 520px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.page-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.group-title {
  font-size: 12px;
  color: var(--text-secondary, #999);
}

.group-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color, #e5e6eb);
  border-radius: 10px;
  background: var(--card-bg, transparent);
}

/* 设置行：文案在左、控件在右，行间用分隔线 */
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 44px;
  padding: 0 14px;
}

.row + .row {
  border-top: 1px solid var(--border-color, #e5e6eb);
}

.row-label {
  font-size: 13px;
}

/* 控件尺寸：输入框 / 下拉框统一小宽度。
   注意 ztools-ui 的 ZInput 是 inheritAttrs:false + 外部 class 透传到内层 input，
   ZSelect 的尺寸则由自身类规则给出——都得从包裹行用 :deep() 命中组件根元素。 */
.row-num :deep(.zt-input) {
  width: 88px;
  flex-shrink: 0;
}

.row-retention :deep(.z-select) {
  width: 116px;
  /* ztools-ui 给 .z-select 定了 min-width: 150px，不一起覆盖则宽度会被顶回 150 */
  min-width: 116px;
  flex-shrink: 0;
}

.row-foot {
  min-height: 40px;
}

.foot-count {
  font-size: 12px;
  color: var(--text-secondary, #999);
}
</style>
