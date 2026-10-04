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

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 转缺陷单：逐条核对结果，ok=false 时 message 说明还差哪一步。 */
export type TransferItemResult = {
  alarmId: number
  alarmCode: string
  ok: boolean
  /** 重复提交：这条告警头一回已经转过，本次不再落新单。 */
  repeated: boolean
  defectCode: string
  message: string
}

export type TransferResult = {
  ok: boolean
  message: string
  items: TransferItemResult[]
  /** 本次新转条数 / 重复提交条数 / 被拦截条数。 */
  transferred: number
  repeated: number
  blocked: number
}

/** 告警侧「已转缺陷」与缺陷侧「告警转单」台账的对账结果。 */
export type TransferReconciliation = {
  alarmTransferred: number
  defectReceived: number
  consistent: boolean
  problems: string[]
}
