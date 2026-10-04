/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

/** 告警转缺陷单：单条告警的核对结论。 */
export type TransferCheck = {
  alarmId: number
  alarmNo: string
  ok: boolean
  /** 已经转过的：只认头一回，直接回沿用首次的缺陷单号，不再新开缺陷。 */
  reused: boolean
  defectNo?: string
  reason?: string
}

export type TransferResult = {
  ok: boolean
  message: string
  items: TransferCheck[]
}

/** 转单对账：告警侧已转条数与缺陷台账告警转单条数要对得上。 */
export type TransferLedger = {
  alarmTransferred: number
  defectFromAlarm: number
  pendingDispatch: number
  matched: boolean
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
