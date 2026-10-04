import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveModules, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  TransferCheck,
  TransferLedger,
  TransferResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 动作的合法前置状态：越级操作当场拦截，并说明还差哪一步。没登记的模块保持原样放行。
const ACTION_GUARDS: Record<string, Record<string, { from: string[]; hint: Record<string, string> }>> = {
  alarm: {
    确认告警: {
      from: ['待确认'],
      hint: {
        已恢复: '告警已恢复，不用再确认',
        已转缺陷: '告警已转缺陷单，不能再确认；要跟进处理请到缺陷消缺',
      },
    },
    登记恢复: {
      from: ['待确认', '处理中'],
      hint: {
        已转缺陷: '告警已转缺陷单，不能登记恢复；要等缺陷消缺闭环',
      },
    },
  },
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (key === ALARM_KEY && action === TRANSFER_ACTION) {
    // 转单必须走 transferAlarmsToDefects：告警状态与缺陷单一起落库，不能只改状态。
    return { ok: false, message: '转缺陷单不能单独改状态，请用列表里的转单入口，告警与缺陷单会一起落库' }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const guard = ACTION_GUARDS[key]?.[action]
  if (guard && !guard.from.includes(current)) {
    const hint = guard.hint[current] ?? `当前状态「${current}」不能执行「${action}」，请先完成前置流转`
    return { ok: false, message: `${meta.entity}${hint}` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 各模块最后一个字段都是「××状态」，流转时一起同步，免得字段和当前状态各说各话。
  const statusField = meta.fields[meta.fields.length - 1]
  if (statusField.endsWith('状态')) {
    updated[statusField] = target
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ===== 告警转缺陷单 =====
// 转单是一次落两处的动作：告警状态与缺陷单编号一起写，任何一步落库不成功都整笔退回，
// 不允许只写告警不落缺陷。转单结论同步进缺陷消缺的待派发台账，两处已转条数要能对上。
const ALARM_KEY = 'alarm'
const DEFECT_KEY = 'defect'
export const TRANSFER_ACTION = '转缺陷单'

// 告警等级 → 缺陷严重等级；既有记录里等级取值不在表内的，按「一般」落单。
const LEVEL_TO_SEVERITY: Record<string, string> = { 紧急: '危急', 重要: '严重', 一般: '一般' }
// 严重等级 → 要求完成日的宽限天数
const SEVERITY_SLA_DAYS: Record<string, number> = { 危急: 1, 严重: 3, 一般: 7 }

function dateText(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function nowStamp(): string {
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return `${dateText(now)} ${hh}:${mm}`
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

// 待确认告警按发生时间补齐：既有记录缺发生时间的补成当天日期并落库，列表才能按发生时间排。
function normalizePendingAlarms(rows: EntryRow[]): { rows: EntryRow[]; changed: boolean } {
  let changed = false
  const next = rows.map((row) => {
    if (row.status === '待确认' && String(row['发生时间'] ?? '').trim() === '') {
      changed = true
      return { ...row, 发生时间: dateText(new Date()) }
    }
    return row
  })
  return { rows: changed ? next : rows, changed }
}

// 告警列表：先补齐待确认告警的发生时间，再把待确认的排在前面、按发生时间升序。
export function listAlarmEntries(filters: Record<string, string> = {}): PageResult {
  const normalized = normalizePendingAlarms(listRows(ALARM_KEY))
  if (normalized.changed) {
    saveRows(ALARM_KEY, normalized.rows)
  }
  const matched = filterRows(normalized.rows, filters)
  const sorted = [...matched].sort((a, b) => {
    const pa = a.status === '待确认' ? 0 : 1
    const pb = b.status === '待确认' ? 0 : 1
    if (pa !== pb) {
      return pa - pb
    }
    if (pa === 0) {
      return String(a['发生时间'] ?? '').localeCompare(String(b['发生时间'] ?? ''))
    }
    return Number(a.id) - Number(b.id)
  })
  return { items: sorted, total: sorted.length, page: 1, size: sorted.length }
}

function findTransferDefect(defects: EntryRow[], alarmNo: string): EntryRow | undefined {
  return defects.find((row) => String(row['来源告警编号'] ?? '') === alarmNo)
}

// 单条告警的转单核对：越权、越级、缺来源都在这一步拦下，并说明还差哪一步。
function checkTransfer(
  alarm: EntryRow | undefined,
  operator: string,
  defects: EntryRow[],
): TransferCheck {
  if (!alarm) {
    return { alarmId: 0, alarmNo: '', ok: false, reused: false, reason: '没有找到这条告警' }
  }
  const base = { alarmId: Number(alarm.id), alarmNo: String(alarm['告警编号'] ?? '') }
  const status = String(alarm.status)
  if (status === '已转缺陷') {
    // 重复提交只认头一回：已有缺陷单的直接沿用单号，不再新开；
    // 旧记录里告警已转但缺陷没落库的，放去补开一张，把两处台账修平。
    const existed = findTransferDefect(defects, base.alarmNo)
    const defectNo = String(alarm['缺陷单号'] ?? '') || String(existed?.['缺陷编号'] ?? '')
    if (defectNo) {
      return { ...base, ok: true, reused: true, defectNo }
    }
    return { ...base, ok: true, reused: false }
  }
  if (status === '待确认') {
    return { ...base, ok: false, reused: false, reason: '还在「待确认」，先执行「确认告警」，确认后才允许转缺陷单' }
  }
  if (status === '已恢复') {
    return { ...base, ok: false, reused: false, reason: '告警已恢复，无需再转缺陷单' }
  }
  if (status !== '处理中') {
    return { ...base, ok: false, reused: false, reason: `当前状态「${status}」不允许转缺陷单` }
  }
  const handler = String(alarm['处置人员'] ?? '').trim()
  if (!handler) {
    return { ...base, ok: false, reused: false, reason: '未登记处置人员，先补登处置人再转单' }
  }
  if (handler !== operator) {
    return { ...base, ok: false, reused: false, reason: `只有本条告警的处置人（${handler}）能转单` }
  }
  const source = String(alarm['告警来源'] ?? '').trim()
  if (!source) {
    return { ...base, ok: false, reused: false, reason: '告警来源缺失，先补登来源再转单' }
  }
  return { ...base, ok: true, reused: false }
}

// 转单前的逐条核对：只读不写，给分组确认弹窗用。
export function precheckTransfer(ids: number[], operator: string): TransferCheck[] {
  const alarms = listRows(ALARM_KEY)
  const defects = listRows(DEFECT_KEY)
  return [...new Set(ids)].map((id) =>
    checkTransfer(alarms.find((row) => Number(row.id) === id), operator, defects),
  )
}

function nextDefectId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextDefectSeq(rows: EntryRow[]): number {
  return (
    rows.reduce((max, row) => {
      const match = /^DEFE-(\d+)$/.exec(String(row['缺陷编号'] ?? ''))
      return match ? Math.max(max, Number(match[1])) : max
    }, 0) + 1
  )
}

// 落库后的回读校验：来源记下来还要对得上——每条新缺陷单都查得到，
// 且来源告警、缺陷单号与告警侧写的一致，对不上就抛错走整笔退回。
function verifyTransfer(defectNos: string[]): void {
  const defects = listRows(DEFECT_KEY)
  const alarms = listRows(ALARM_KEY)
  for (const no of defectNos) {
    const defect = defects.find((row) => row['缺陷编号'] === no)
    if (!defect) {
      throw new Error(`缺陷单 ${no} 回读不到`)
    }
    const alarmNo = String(defect['来源告警编号'] ?? '')
    const alarm = alarms.find((row) => String(row['告警编号'] ?? '') === alarmNo)
    if (!alarm || alarm.status !== '已转缺陷' || String(alarm['缺陷单号'] ?? '') !== no) {
      throw new Error(`缺陷单 ${no} 与告警侧对不上`)
    }
    if (String(defect['发现方式'] ?? '') !== String(alarm['告警来源'] ?? '').trim()) {
      throw new Error(`缺陷单 ${no} 记下的来源与告警不一致`)
    }
  }
}

export function transferAlarmsToDefects(ids: number[], operator: string): TransferResult {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) {
    return { ok: false, message: '请先勾选要转缺陷单的告警', items: [] }
  }
  const alarmRows = listRows(ALARM_KEY)
  const defectRows = listRows(DEFECT_KEY)
  const checks = precheckTransfer(uniqueIds, operator)

  // 先排练：该开的缺陷、该改的告警都在内存里排好，再一次落两处。
  const nextDefects = [...defectRows]
  const alarmPatch = new Map<number, EntryRow>()
  let defectSeq = nextDefectSeq(defectRows)
  let defectId = nextDefectId(defectRows)
  const stamp = nowStamp()
  const stagedDefectNos: string[] = []

  for (const check of checks) {
    if (!check.ok) {
      continue
    }
    const alarm = alarmRows.find((row) => Number(row.id) === check.alarmId)
    if (!alarm) {
      continue
    }
    if (check.reused) {
      // 旧记录告警侧缺缺陷单号的，顺手把关联补回来。
      if (check.defectNo && !alarm['缺陷单号']) {
        alarmPatch.set(check.alarmId, { ...alarm, 缺陷单号: check.defectNo })
      }
      continue
    }
    const defectNo = `DEFE-${String(defectSeq++).padStart(4, '0')}`
    const level = String(alarm['告警等级'] ?? '').trim()
    const severity = LEVEL_TO_SEVERITY[level] ?? '一般'
    const source = String(alarm['告警来源'] ?? '').trim()
    nextDefects.push({
      id: defectId++,
      status: '待派发',
      pending: true,
      abnormal: false,
      缺陷编号: defectNo,
      缺陷类别: '设备缺陷',
      发现方式: source,
      严重等级: severity,
      责任班组: '待派发',
      要求完成日: dateText(addDays(new Date(), SEVERITY_SLA_DAYS[severity] ?? 7)),
      消缺措施: '待派发后制定',
      消缺状态: '待派发',
      来源告警编号: check.alarmNo,
      来源告警等级: level || '未登记',
      转单人: operator,
      转单时间: stamp,
    })
    check.defectNo = defectNo
    stagedDefectNos.push(defectNo)
    alarmPatch.set(check.alarmId, {
      ...alarm,
      status: '已转缺陷',
      pending: false,
      abnormal: false,
      告警状态: '已转缺陷',
      缺陷单号: defectNo,
      转单时间: stamp,
    })
  }

  const blocked = checks.filter((item) => !item.ok)
  const reused = checks.filter((item) => item.ok && item.reused)
  const created = checks.filter((item) => item.ok && !item.reused)

  if (alarmPatch.size === 0) {
    // 整批都是重复提交：只认头一回，算幂等成功，不算失败。
    if (blocked.length === 0 && reused.length > 0) {
      return { ok: true, message: `${reused.length} 条此前已转过，只认头一回，未重复开单`, items: checks }
    }
    const reason = blocked[0]?.reason ?? '没有需要落库的转单'
    const message =
      uniqueIds.length === 1 && blocked.length === 1
        ? reason
        : `本批 ${uniqueIds.length} 条都未能转单：${reason}`
    return { ok: false, message, items: checks }
  }

  const nextAlarms = alarmRows.map((row) => alarmPatch.get(Number(row.id)) ?? row)

  // 落库：两处一起写；写不进去或回读对不上，都整笔退回。
  try {
    saveModules({ [ALARM_KEY]: nextAlarms, [DEFECT_KEY]: nextDefects })
    verifyTransfer(stagedDefectNos)
  } catch (error) {
    try {
      saveModules({ [ALARM_KEY]: alarmRows, [DEFECT_KEY]: defectRows })
    } catch {
      // 退回也失败时缓存仍保持排练前的版本，页面重载后以存储里的为准。
    }
    return {
      ok: false,
      message: `转单落库失败，已整笔退回，告警与缺陷台账均未改动（${error instanceof Error ? error.message : '存储写入异常'}）`,
      items: checks.map((item) =>
        item.ok && !item.reused ? { ...item, ok: false, defectNo: undefined, reason: '落库失败，已整笔退回' } : item,
      ),
    }
  }

  const parts = [`新转 ${created.length} 条，缺陷单已落入待派发台账`]
  if (reused.length) {
    parts.push(`${reused.length} 条此前已转过，只认头一回`)
  }
  if (blocked.length) {
    parts.push(`${blocked.length} 条被拦截`)
  }
  return { ok: true, message: parts.join('；'), items: checks }
}

// 转单对账：告警侧已转条数与缺陷台账告警转单条数要一致。
export function transferLedger(): TransferLedger {
  const alarms = listRows(ALARM_KEY)
  const defects = listRows(DEFECT_KEY)
  const fromAlarm = defects.filter((row) => String(row['来源告警编号'] ?? '') !== '')
  const alarmTransferred = alarms.filter((row) => row.status === '已转缺陷').length
  return {
    alarmTransferred,
    defectFromAlarm: fromAlarm.length,
    pendingDispatch: fromAlarm.filter((row) => row.status === '待派发').length,
    matched: alarmTransferred === fromAlarm.length,
  }
}
