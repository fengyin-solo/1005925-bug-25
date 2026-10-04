import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveAll, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  TransferItemResult,
  TransferReconciliation,
  TransferResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

// ---- 既有记录兼容：老数据缺字段、缺发生时间，读取时补齐落库，页面不用关心数据是哪一版 ----

function normalizeAlarmRows(rows: EntryRow[]): EntryRow[] | null {
  let changed = false
  const next = rows.map((row, index) => {
    const patched = { ...row }
    if (typeof patched.缺陷编号 !== 'string') {
      patched.缺陷编号 = String(patched.缺陷编号 ?? '')
      changed = true
    }
    if (!String(patched.发生时间 ?? '').trim()) {
      // 待确认告警按发生时间补齐：老记录缺时间的按列表顺序补一个确定性的时间，排序不漂
      patched.发生时间 = `2026-09-01 08:${String(index).padStart(2, '0')}`
      changed = true
    }
    return patched
  })
  return changed ? next : null
}

const ROW_NORMALIZERS: Record<string, (rows: EntryRow[]) => EntryRow[] | null> = {
  alarm: normalizeAlarmRows,
}

function moduleRows(key: string): EntryRow[] {
  const rows = listRows(key)
  const normalize = ROW_NORMALIZERS[key]
  if (!normalize) {
    return rows
  }
  const normalized = normalize(rows)
  if (normalized) {
    saveRows(key, normalized)
    return normalized
  }
  return rows
}

// 待确认告警按发生时间排前（最早发生的先处置），其余保持登记顺序
function sortAlarmRows(rows: EntryRow[]): EntryRow[] {
  return [...rows].sort((a, b) => {
    const ap = String(a.status) === '待确认' ? 0 : 1
    const bp = String(b.status) === '待确认' ? 0 : 1
    if (ap !== bp) {
      return ap - bp
    }
    if (ap === 0) {
      const byTime = String(a.发生时间 ?? '').localeCompare(String(b.发生时间 ?? ''))
      if (byTime !== 0) {
        return byTime
      }
    }
    return Number(a.id) - Number(b.id)
  })
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
  let matched = filterRows(moduleRows(key), filters)
  if (key === 'alarm') {
    matched = sortAlarmRows(matched)
  }
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// ---- 告警模块的流转约束：越权、越级当场拦截，并说明还差哪一步 ----

const TRANSFER_ACTION = '转缺陷单'
const ALARM_TRANSFERRED_STATUS = '已转缺陷'
const DEFECT_PENDING_STATUS = '待派发'

const ALARM_FLOW_GUARDS: Record<string, { from: string[]; hint: (row: EntryRow) => string }> = {
  确认告警: {
    from: ['待确认'],
    hint: (row) =>
      String(row.status) === ALARM_TRANSFERRED_STATUS
        ? `该告警已转缺陷（缺陷单 ${row.缺陷编号 || '未登记'}），不用再确认`
        : `该告警已是「${row.status}」，只有「待确认」的告警才能确认`,
  },
  登记恢复: {
    from: ['处理中'],
    hint: (row) => {
      const status = String(row.status)
      if (status === '待确认') {
        return '越级拦截：告警还没确认，先「确认告警」置为处理中，才能登记恢复'
      }
      if (status === ALARM_TRANSFERRED_STATUS) {
        return `该告警已转缺陷（缺陷单 ${row.缺陷编号 || '未登记'}），恢复结论请走缺陷消缺闭环`
      }
      return `该告警已是「${status}」，不用重复登记恢复`
    },
  },
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = moduleRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  if (key === 'alarm') {
    if (action === TRANSFER_ACTION) {
      // 转单必须告警状态与缺陷台账一笔写入，通用流转只改状态，会落出半截数据
      return { ok: false, message: '转缺陷单请在转单面板落单：告警状态与缺陷台账一笔写入，不能单独改状态' }
    }
    const guard = ALARM_FLOW_GUARDS[action]
    if (guard && !guard.from.includes(String(rows[index].status))) {
      return { ok: false, message: guard.hint(rows[index]) }
    }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// ---- 告警转缺陷单：一次落两处，重复提交只认头一回 ----

// 告警来源的归一化口径：新记录用标准叫法，既有记录里的旧叫法、自由文本也认（保留原文）
const KNOWN_SOURCES = ['监控预警', '巡视发现', '调度下发', '用户报修']
const SOURCE_ALIASES: Record<string, string> = {
  监控: '监控预警',
  监控系统: '监控预警',
  scada: '监控预警',
  巡检: '巡视发现',
  巡视: '巡视发现',
  调度: '调度下发',
  电话: '用户报修',
  报修: '用户报修',
}

export function normalizeAlarmSource(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (!text) {
    return ''
  }
  if (KNOWN_SOURCES.includes(text)) {
    return text
  }
  return SOURCE_ALIASES[text] ?? SOURCE_ALIASES[text.toLowerCase()] ?? text
}

const LEVEL_TO_SEVERITY: Record<string, string> = { 一级: '紧急', 二级: '重大', 三级: '一般' }
const LEVEL_DUE_DAYS: Record<string, number> = { 一级: 1, 二级: 3, 三级: 7 }

function defectCategoryOf(device: string): string {
  const prefix = device.split('-')[0]
  const names: Record<string, string> = {
    INVE: '逆变器缺陷',
    COMB: '汇流箱缺陷',
    ARRA: '组串缺陷',
    TRAC: '跟踪支架缺陷',
    METE: '计量装置缺陷',
  }
  return names[prefix] ?? '设备缺陷'
}

function dueDateOf(level: string, from: Date): string {
  const days = LEVEL_DUE_DAYS[level] ?? 7
  const at = new Date(from.getTime() + days * 24 * 60 * 60 * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

// 缺陷编号取告警侧、缺陷侧两边已用号段的最大值，重转补单也不会撞号
function nextDefectSeq(alarms: EntryRow[], defects: EntryRow[]): number {
  let max = 0
  for (const row of [...alarms, ...defects]) {
    const match = /^DEFE-(\d+)$/.exec(String(row.缺陷编号 ?? ''))
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return max + 1
}

type TransferCheck = { ok: boolean; repeated: boolean; defectCode: string; message: string }

function checkTransferable(alarm: EntryRow, defects: EntryRow[], operator: string): TransferCheck {
  const code = String(alarm.告警编号 ?? '')
  const status = String(alarm.status)
  const recorded = String(alarm.缺陷编号 ?? '').trim()
  const existing = defects.find((row) => String(row.来源告警 ?? '') === code)

  // 重复提交只认头一回：台账里已有这条告警转出的缺陷单，不再落新单
  if (existing) {
    return {
      ok: false,
      repeated: true,
      defectCode: String(existing.缺陷编号 ?? recorded),
      message: `重复提交：${code} 头一回已转成 ${existing.缺陷编号}，本次不再重复落单`,
    }
  }
  // 越权拦截：只有本条告警的处置人能转单
  const handler = String(alarm.处置人员 ?? '').trim()
  if (handler && handler !== operator) {
    return {
      ok: false,
      repeated: false,
      defectCode: '',
      message: `越权拦截：${code} 的处置人是 ${handler}，当前值班 ${operator} 不能转单`,
    }
  }
  if (status === ALARM_TRANSFERRED_STATUS) {
    // 告警侧标了已转、台账却没有对应条目：老数据留下的半截账，允许重转补齐，沿用原编号
    return {
      ok: true,
      repeated: false,
      defectCode: recorded,
      message: recorded
        ? `台账缺 ${recorded} 这一条，本次按原编号补落缺陷单`
        : '告警侧标了已转但台账缺单，本次补落缺陷单',
    }
  }
  if (status === '待确认') {
    return {
      ok: false,
      repeated: false,
      defectCode: '',
      message: `越级拦截：${code} 还没确认，先「确认告警」再转缺陷单`,
    }
  }
  if (status !== '处理中') {
    return {
      ok: false,
      repeated: false,
      defectCode: '',
      message: `${code} 当前状态「${status}」，只有处理中的告警能转缺陷单`,
    }
  }
  if (!normalizeAlarmSource(alarm.告警来源)) {
    return {
      ok: false,
      repeated: false,
      defectCode: '',
      message: `${code} 缺少告警来源，先补齐来源再转单`,
    }
  }
  return { ok: true, repeated: false, defectCode: '', message: '' }
}

/** 落单前的逐条核对：只校验不写库，转单面板按等级分组展示核对结论。 */
export function precheckTransfer(alarmIds: number[], operator: string): TransferItemResult[] {
  const alarms = moduleRows('alarm')
  const defects = moduleRows('defect')
  return [...new Set(alarmIds)].map((id) => {
    const alarm = alarms.find((row) => Number(row.id) === id)
    if (!alarm) {
      return {
        alarmId: id,
        alarmCode: `#${id}`,
        ok: false,
        repeated: false,
        defectCode: '',
        message: `没有找到编号为 ${id} 的告警`,
      }
    }
    const check = checkTransferable(alarm, defects, operator)
    return {
      alarmId: id,
      alarmCode: String(alarm.告警编号 ?? `#${id}`),
      ok: check.ok,
      repeated: check.repeated,
      defectCode: check.defectCode,
      message: check.ok ? check.message || '核对通过，可以落单' : check.message,
    }
  })
}

/**
 * 转缺陷单：告警状态与缺陷单编号一起写、缺陷台账同步落待派发，一笔落库。
 * 落库不成功就整笔退回，不会只写告警不落缺陷。
 */
export function transferAlarms(alarmIds: number[], operator: string): TransferResult {
  const uniqueIds = [...new Set(alarmIds)]
  const empty = { items: [] as TransferItemResult[], transferred: 0, repeated: 0, blocked: 0 }
  if (uniqueIds.length === 0) {
    return { ok: false, message: '没有勾选要转单的告警', ...empty }
  }
  const alarms = moduleRows('alarm')
  const defects = moduleRows('defect')
  const items: TransferItemResult[] = []
  const ready: { alarm: EntryRow; defectCode: string }[] = []
  const seenCodes = new Set<string>()

  // 逐条核对：越权、越级、缺来源、重复提交当场拦截
  for (const id of uniqueIds) {
    const alarm = alarms.find((row) => Number(row.id) === id)
    if (!alarm) {
      items.push({ alarmId: id, alarmCode: `#${id}`, ok: false, repeated: false, defectCode: '', message: `没有找到编号为 ${id} 的告警` })
      continue
    }
    const code = String(alarm.告警编号 ?? `#${id}`)
    if (seenCodes.has(code)) {
      items.push({ alarmId: id, alarmCode: code, ok: false, repeated: true, defectCode: '', message: `重复提交：${code} 在本批里已核对过，只落一单` })
      continue
    }
    seenCodes.add(code)
    const check = checkTransferable(alarm, defects, operator)
    if (!check.ok) {
      items.push({ alarmId: id, alarmCode: code, ok: false, repeated: check.repeated, defectCode: check.defectCode, message: check.message })
      continue
    }
    ready.push({ alarm, defectCode: check.defectCode })
    items.push({ alarmId: id, alarmCode: code, ok: true, repeated: false, defectCode: check.defectCode, message: '核对通过，待落单' })
  }

  const repeated = items.filter((item) => item.repeated).length
  if (ready.length === 0) {
    return {
      ok: false,
      message: repeated > 0 ? '本批都是重复提交，头一回的转单结论保持不变' : '本批没有可落单的告警，已逐条拦截',
      items,
      transferred: 0,
      repeated,
      blocked: items.length - repeated,
    }
  }

  // 备好两边的完整新数据：告警侧写状态+缺陷编号，缺陷侧补待派发台账条目
  const now = new Date()
  let seq = nextDefectSeq(alarms, defects)
  let maxDefectId = defects.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  const newDefects: EntryRow[] = []
  const defectCodeByAlarmId = new Map<number, string>()
  for (const { alarm, defectCode } of ready) {
    let code = defectCode
    if (!code) {
      code = `DEFE-${String(seq).padStart(4, '0')}`
      seq += 1
    }
    defectCodeByAlarmId.set(Number(alarm.id), code)
    maxDefectId += 1
    const level = String(alarm.告警等级 ?? '')
    newDefects.push({
      id: maxDefectId,
      status: DEFECT_PENDING_STATUS,
      pending: true,
      abnormal: false,
      缺陷编号: code,
      缺陷类别: defectCategoryOf(String(alarm.关联设备 ?? '')),
      发现方式: `告警转单·${normalizeAlarmSource(alarm.告警来源)}`,
      严重等级: LEVEL_TO_SEVERITY[level] ?? '一般',
      责任班组: '待派发',
      要求完成日: dueDateOf(level, now),
      消缺措施: '待派发后补充',
      消缺状态: DEFECT_PENDING_STATUS,
      来源告警: String(alarm.告警编号 ?? ''),
    })
  }

  const readyIds = new Set(ready.map(({ alarm }) => Number(alarm.id)))
  const nextAlarms = alarms.map((row) =>
    readyIds.has(Number(row.id))
      ? {
          ...row,
          status: ALARM_TRANSFERRED_STATUS,
          pending: false,
          abnormal: false,
          告警状态: ALARM_TRANSFERRED_STATUS,
          缺陷编号: defectCodeByAlarmId.get(Number(row.id)) ?? '',
        }
      : row,
  )

  try {
    saveAll({ ...allRows(), alarm: nextAlarms, defect: [...defects, ...newDefects] })
  } catch (error) {
    // 落库不成功就整笔退回：内存缓存和 localStorage 都保持原样
    const reason = error instanceof Error ? error.message : '存储写入异常'
    const rolledBack = items.map((item) =>
      item.ok ? { ...item, ok: false, message: '落库失败，整笔退回' } : item,
    )
    return {
      ok: false,
      message: `落库失败，整笔已退回：${reason}`,
      items: rolledBack,
      transferred: 0,
      repeated,
      blocked: rolledBack.filter((item) => !item.ok && !item.repeated).length,
    }
  }

  const finalItems = items.map((item) => {
    if (!item.ok) {
      return item
    }
    const code = defectCodeByAlarmId.get(item.alarmId) ?? ''
    return { ...item, defectCode: code, message: `已转缺陷单 ${code}，台账待派发` }
  })
  return {
    ok: true,
    message: `本次转单 ${ready.length} 条，缺陷台账已同步待派发`,
    items: finalItems,
    transferred: ready.length,
    repeated,
    blocked: finalItems.filter((item) => !item.ok && !item.repeated).length,
  }
}

/** 转单对账：告警侧「已转缺陷」条数要与缺陷侧「告警转单」台账条数对得上。 */
export function transferReconciliation(): TransferReconciliation {
  const alarms = moduleRows('alarm')
  const defects = moduleRows('defect')
  const transferred = alarms.filter((row) => String(row.status) === ALARM_TRANSFERRED_STATUS)
  const received = defects.filter((row) => String(row.来源告警 ?? '').trim() !== '')
  const defectByCode = new Map(defects.map((row) => [String(row.缺陷编号 ?? ''), row]))
  const problems: string[] = []
  for (const alarm of transferred) {
    const code = String(alarm.缺陷编号 ?? '').trim()
    if (!code) {
      problems.push(`${alarm.告警编号} 标了已转缺陷但没记缺陷编号`)
      continue
    }
    const defect = defectByCode.get(code)
    if (!defect) {
      problems.push(`${alarm.告警编号} 记的缺陷单 ${code} 在台账里找不到`)
    } else if (String(defect.来源告警 ?? '') !== String(alarm.告警编号 ?? '')) {
      problems.push(`缺陷单 ${code} 的来源告警没有回指 ${alarm.告警编号}`)
    }
  }
  return {
    alarmTransferred: transferred.length,
    defectReceived: received.length,
    consistent: problems.length === 0 && transferred.length === received.length,
    problems,
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of moduleRows(key)) {
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
