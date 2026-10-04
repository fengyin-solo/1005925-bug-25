<template>
  <section class="page" data-module="alarm">
    <header class="page-head">
      <div>
        <h2>告警事件管理</h2>
        <p class="page-desc">维护告警事件，围绕告警编号、告警等级、告警来源、发生时间做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记告警事件</button>
        <button
          class="btn primary"
          type="button"
          :disabled="!selectedIds.length"
          @click="openTransfer"
        >
          批量转缺陷单（{{ selectedIds.length }}）
        </button>
        <button class="btn" type="button" @click="exportRows">导出告警事件清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <p class="ledger-line" :class="{ 'ledger-bad': !ledger.matched }">
      转单对账：告警侧已转缺陷 {{ ledger.alarmTransferred }} 条 · 缺陷台账告警转单
      {{ ledger.defectFromAlarm }} 条（待派发 {{ ledger.pendingDispatch }} 条） ·
      {{ ledger.matched ? '两处条数对得上' : '两处条数对不上，请核查' }}
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>
            <input
              type="checkbox"
              :checked="allSelectableChecked"
              :disabled="!selectableIds.length"
              @change="toggleAll"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>缺陷单号</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>
            <input
              type="checkbox"
              :checked="selectedIds.includes(Number(row.id))"
              :disabled="!isSelectable(row)"
              @change="toggleOne(Number(row.id))"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>{{ row['缺陷单号'] ?? '—' }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无告警事件数据，可先登记告警事件</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条告警事件记录</span>
      <span v-if="okMessage" class="ok-text">{{ okMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="showTransfer" class="modal-mask" @click.self="showTransfer = false">
      <div class="modal-panel">
        <header class="modal-head">
          <h3>批量转缺陷单 · 按告警等级分组核对</h3>
          <button class="btn ghost" type="button" @click="showTransfer = false">关闭</button>
        </header>
        <p class="modal-tip">
          成组勾选、逐条核对再落单：告警状态与缺陷单号一次落两处，落库不成功整笔退回；已转过的只认头一回。
        </p>
        <section v-for="group in transferGroups" :key="group.level" class="transfer-group">
          <header class="transfer-group-head">
            <label>
              <input
                type="checkbox"
                :checked="groupChecked(group)"
                :disabled="!group.items.some((item) => item.check.ok)"
                @change="toggleGroup(group, ($event.target as HTMLInputElement).checked)"
              />
              告警等级：{{ group.level }}（{{ group.items.length }} 条）
            </label>
          </header>
          <ul class="transfer-list">
            <li v-for="item in group.items" :key="item.check.alarmId" class="transfer-item">
              <label>
                <input
                  type="checkbox"
                  :checked="commitIds.includes(item.check.alarmId)"
                  :disabled="!item.check.ok"
                  @change="toggleCommit(item.check.alarmId, ($event.target as HTMLInputElement).checked)"
                />
                {{ item.row['告警编号'] }} · {{ item.row['关联设备'] }} ·
                {{ item.row['发生时间'] }} · 处置人 {{ item.row['处置人员'] }}
              </label>
              <span v-if="item.check.ok && item.check.reused" class="check-tag reuse">
                已转过：{{ item.check.defectNo }}
              </span>
              <span v-else-if="item.check.ok" class="check-tag pass">可转</span>
              <span v-else class="check-tag block">{{ item.check.reason }}</span>
            </li>
          </ul>
        </section>
        <footer class="modal-foot">
          <span>本次落单 {{ commitIds.length }} 条</span>
          <button
            class="btn primary"
            type="button"
            :disabled="!commitIds.length || committing"
            @click="commitTransfer"
          >
            核对无误，落单
          </button>
        </footer>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listAlarmEntries,
  moduleMeta,
  precheckTransfer,
  runAction as applyAction,
  transferAlarmsToDefects,
  transferLedger,
  TRANSFER_ACTION,
} from '@/api/local-service'
import type { EntryRow, TransferCheck, TransferLedger } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('alarm')
const columns = ["告警编号", "告警等级", "告警来源", "发生时间", "持续时长", "关联设备", "处置人员", "告警状态"]
const actions = ["确认告警", "登记恢复", "转缺陷单"]
const statuses = ["待确认", "处理中", "已恢复", "已转缺陷"]
const stats = [{"label": "待确认告警", "value": 0}, {"label": "处理中告警", "value": 0}, {"label": "今日恢复告警", "value": 0}]

const session = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const ledger = ref<TransferLedger>({ alarmTransferred: 0, defectFromAlarm: 0, pendingDispatch: 0, matched: true })

const selectedIds = ref<number[]>([])
const showTransfer = ref(false)
const transferChecks = ref<TransferCheck[]>([])
const commitIds = ref<number[]>([])
const committing = ref(false)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 只有「处理中」的告警才允许勾选转单；越权、缺来源等在核对环节逐条说明。
const selectableIds = computed(() =>
  rows.value.filter((row) => isSelectable(row)).map((row) => Number(row.id)),
)
const allSelectableChecked = computed(
  () =>
    selectableIds.value.length > 0 &&
    selectableIds.value.every((id) => selectedIds.value.includes(id)),
)

type TransferGroup = {
  level: string
  items: { row: EntryRow; check: TransferCheck }[]
}

// 多条一起转时按告警等级分组，成组勾选后逐条核对。
const transferGroups = computed<TransferGroup[]>(() => {
  const byLevel = new Map<string, TransferGroup>()
  for (const check of transferChecks.value) {
    const row = rows.value.find((item) => Number(item.id) === check.alarmId)
    if (!row) {
      continue
    }
    const level = String(row['告警等级'] ?? '').trim() || '未登记'
    if (!byLevel.has(level)) {
      byLevel.set(level, { level, items: [] })
    }
    byLevel.get(level)!.items.push({ row, check })
  }
  return [...byLevel.values()]
})

function isSelectable(row: EntryRow): boolean {
  return String(row.status) === '处理中'
}

function toggleOne(id: number) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function toggleAll() {
  selectedIds.value = allSelectableChecked.value ? [] : [...selectableIds.value]
}

function groupChecked(group: TransferGroup): boolean {
  const eligible = group.items.filter((item) => item.check.ok)
  return eligible.length > 0 && eligible.every((item) => commitIds.value.includes(item.check.alarmId))
}

function toggleGroup(group: TransferGroup, on: boolean) {
  const ids = group.items.filter((item) => item.check.ok).map((item) => item.check.alarmId)
  const rest = commitIds.value.filter((id) => !ids.includes(id))
  commitIds.value = on ? [...rest, ...ids] : rest
}

function toggleCommit(id: number, on: boolean) {
  commitIds.value = on
    ? [...commitIds.value.filter((item) => item !== id), id]
    : commitIds.value.filter((item) => item !== id)
}

function openTransfer() {
  errorMessage.value = ''
  okMessage.value = ''
  if (!selectedIds.value.length) {
    errorMessage.value = '请先勾选要转缺陷单的告警'
    return
  }
  transferChecks.value = precheckTransfer(selectedIds.value, session.operator)
  commitIds.value = transferChecks.value.filter((check) => check.ok).map((check) => check.alarmId)
  showTransfer.value = true
}

function commitTransfer() {
  if (committing.value) {
    return
  }
  committing.value = true
  try {
    const result = transferAlarmsToDefects(commitIds.value, session.operator)
    showTransfer.value = false
    selectedIds.value = []
    const blocked = result.items.filter((item) => !item.ok && item.reason)
    errorMessage.value = blocked.map((item) => `${item.alarmNo}：${item.reason}`).join('；')
    okMessage.value = result.ok ? result.message : ''
    if (!result.ok && !blocked.length) {
      errorMessage.value = result.message
    }
    reload()
  } finally {
    committing.value = false
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '告警事件登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  if (action === TRANSFER_ACTION) {
    const result = transferAlarmsToDefects([Number(row.id)], session.operator)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    okMessage.value = result.message
    reload()
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listAlarmEntries(filters.value)
    rows.value = payload.items
    total.value = payload.total
    ledger.value = transferLedger()
    // 已转走的告警不再可选，把失效的勾选项清掉
    selectedIds.value = selectedIds.value.filter((id) =>
      payload.items.some((row) => Number(row.id) === id && isSelectable(row)),
    )
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '告警事件列表读取失败'
  }
}

onMounted(reload)
</script>
