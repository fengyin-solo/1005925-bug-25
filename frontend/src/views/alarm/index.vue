<template>
  <section class="page" data-module="alarm">
    <header class="page-head">
      <div>
        <h2>告警事件管理</h2>
        <p class="page-desc">维护告警事件，围绕告警编号、告警等级、告警来源、发生时间做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记告警事件</button>
        <button class="btn" type="button" @click="openBatchTransfer">批量转缺陷单</button>
        <button class="btn" type="button" @click="exportRows">导出告警事件清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="recon" class="recon-line">
      转单对账：告警侧已转缺陷 {{ recon.alarmTransferred }} 条 · 缺陷台账已收 {{ recon.defectReceived }} 条 ·
      <span v-if="recon.consistent" class="ok-text">两处条数对得上</span>
      <span v-else class="error-text">对不上：{{ recon.problems.join('；') || '条数不一致' }}</span>
    </p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
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
          <th class="check-cell">
            <input
              type="checkbox"
              title="全选可转单的处理中告警"
              :checked="allTransferableSelected"
              @change="toggleSelectAll"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td class="check-cell">
            <input
              type="checkbox"
              :disabled="!isTransferable(row)"
              :title="isTransferable(row) ? '勾选后可批量转缺陷单' : '只有处理中的告警能勾选转单'"
              :checked="selected.includes(Number(row.id))"
              @change="toggleSelect(Number(row.id))"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
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
          <td :colspan="columns.length + 3" class="empty-state">暂无告警事件数据，可先登记告警事件</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条告警事件记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="panelOpen" class="panel-mask" @click.self="closePanel">
      <div class="panel">
        <h3>告警转缺陷单 · 按告警等级分组核对</h3>
        <p class="panel-tip">
          成组勾选后逐条核对，核对通过的才会落单；告警状态与缺陷台账一笔写入，落库失败整笔退回，重复提交只认头一回。
        </p>
        <div v-for="group in panelGroups" :key="group.level" class="panel-group">
          <h4>{{ group.level }}（{{ group.items.length }} 条）</h4>
          <table class="data-table">
            <thead>
              <tr>
                <th class="check-cell">核对</th>
                <th>告警编号</th>
                <th>发生时间</th>
                <th>关联设备</th>
                <th>处置人员</th>
                <th>核对结论</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in group.items" :key="String(item.id)">
                <td class="check-cell">
                  <input
                    type="checkbox"
                    :disabled="!checkOf(Number(item.id))?.ok"
                    :checked="confirmed.includes(Number(item.id))"
                    @change="toggleConfirm(Number(item.id))"
                  />
                </td>
                <td>{{ item.告警编号 }}</td>
                <td>{{ item.发生时间 }}</td>
                <td>{{ item.关联设备 }}</td>
                <td>{{ item.处置人员 }}</td>
                <td :class="verdictClass(Number(item.id))">{{ checkOf(Number(item.id))?.message }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="results" class="panel-results">
          <h4>落单结论</h4>
          <ul>
            <li v-for="item in results" :key="item.alarmId" :class="item.ok ? 'ok-text' : item.repeated ? '' : 'error-text'">
              {{ item.alarmCode }}：{{ item.message }}
            </li>
          </ul>
        </div>

        <footer class="panel-foot">
          <span v-if="panelError" class="error-text">{{ panelError }}</span>
          <button class="btn" type="button" @click="closePanel">关闭</button>
          <button
            v-if="!results"
            class="btn primary"
            type="button"
            :disabled="!allConfirmed || submitting"
            @click="confirmTransfer"
          >
            {{ submitting ? '落单中…' : '核对无误，落单' }}
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
  listEntries,
  moduleMeta,
  precheckTransfer,
  transferAlarms,
  transferReconciliation,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, TransferItemResult, TransferReconciliation } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('alarm')
const columns = ["告警编号", "告警等级", "告警来源", "发生时间", "持续时长", "关联设备", "处置人员", "告警状态", "缺陷编号"]
const actions = ["确认告警", "登记恢复", "转缺陷单"]
const statuses = ["待确认", "处理中", "已恢复", "已转缺陷"]
const TRANSFER_ACTION = '转缺陷单'

const session = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const recon = ref<TransferReconciliation | null>(null)

const selected = ref<number[]>([])
const panelOpen = ref(false)
const panelIds = ref<number[]>([])
const checks = ref<TransferItemResult[]>([])
const confirmed = ref<number[]>([])
const submitting = ref(false)
const results = ref<TransferItemResult[] | null>(null)
const panelError = ref('')

const stats = computed(() => [
  { label: '待确认告警', value: rows.value.filter((row) => String(row.status) === '待确认').length },
  { label: '处理中告警', value: rows.value.filter((row) => String(row.status) === '处理中').length },
  { label: '已转缺陷', value: rows.value.filter((row) => String(row.status) === '已转缺陷').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const transferableIds = computed(() =>
  rows.value.filter(isTransferable).map((row) => Number(row.id)),
)

const allTransferableSelected = computed(
  () => transferableIds.value.length > 0 && transferableIds.value.every((id) => selected.value.includes(id)),
)

const panelGroups = computed(() => {
  const byId = new Map(rows.value.map((row) => [Number(row.id), row]))
  const groups = new Map<string, EntryRow[]>()
  for (const id of panelIds.value) {
    const row = byId.get(id)
    if (!row) {
      continue
    }
    const level = String(row.告警等级 ?? '').trim() || '未分级'
    const list = groups.get(level) ?? []
    list.push(row)
    groups.set(level, list)
  }
  const order = ['一级', '二级', '三级']
  return [...groups.entries()]
    .sort((a, b) => {
      const ia = order.indexOf(a[0])
      const ib = order.indexOf(b[0])
      return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib)
    })
    .map(([level, items]) => ({ level, items }))
})

const validChecks = computed(() => checks.value.filter((item) => item.ok))

const allConfirmed = computed(
  () =>
    validChecks.value.length > 0 &&
    validChecks.value.every((item) => confirmed.value.includes(item.alarmId)),
)

function isTransferable(row: EntryRow): boolean {
  return String(row.status) === '处理中'
}

function checkOf(id: number): TransferItemResult | undefined {
  return checks.value.find((item) => item.alarmId === id)
}

function verdictClass(id: number): string {
  const check = checkOf(id)
  if (!check) {
    return ''
  }
  if (check.ok) {
    return 'ok-text'
  }
  return check.repeated ? 'muted-text' : 'error-text'
}

function toggleSelect(id: number) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((item) => item !== id)
    : [...selected.value, id]
}

function toggleSelectAll() {
  selected.value = allTransferableSelected.value ? [] : [...transferableIds.value]
}

function toggleConfirm(id: number) {
  confirmed.value = confirmed.value.includes(id)
    ? confirmed.value.filter((item) => item !== id)
    : [...confirmed.value, id]
}

function openTransferPanel(ids: number[]) {
  panelIds.value = ids
  checks.value = precheckTransfer(ids, session.operator)
  confirmed.value = []
  results.value = null
  panelError.value = ''
  panelOpen.value = true
}

function openBatchTransfer() {
  errorMessage.value = ''
  if (selected.value.length === 0) {
    errorMessage.value = '先勾选处理中的告警，再批量转缺陷单'
    return
  }
  openTransferPanel([...selected.value])
}

function closePanel() {
  panelOpen.value = false
}

function confirmTransfer() {
  if (submitting.value) {
    return
  }
  submitting.value = true
  panelError.value = ''
  try {
    const ids = validChecks.value.map((item) => item.alarmId)
    const result = transferAlarms(ids, session.operator)
    results.value = result.items
    if (!result.ok) {
      panelError.value = result.message
    }
    selected.value = selected.value.filter((id) => !ids.includes(id))
    reload()
  } finally {
    submitting.value = false
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
  if (action === TRANSFER_ACTION) {
    // 转单走面板：先逐条核对再落单，越权、越级、重复提交在面板里当场说明
    openTransferPanel([Number(row.id)])
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
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    recon.value = transferReconciliation()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '告警事件列表读取失败'
  }
}

onMounted(reload)
</script>
