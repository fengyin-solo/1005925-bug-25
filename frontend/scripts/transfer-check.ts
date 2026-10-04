// 转单逻辑的端到端校验：esbuild 打包后在 node 里跑，localStorage 用内存 shim。
const store = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
}

import {
  listEntries,
  normalizeAlarmSource,
  precheckTransfer,
  runAction,
  transferAlarms,
  transferReconciliation,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'

let failures = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name} ${extra}`)
  }
}

const alarms = () => listRows('alarm')
const defects = () => listRows('defect')
const byCode = (rows: any[], code: string) => rows.find((r) => r.告警编号 === code || r.缺陷编号 === code)

// ---- 1. 正常转单：一次落两处 ----
const before = { alarms: alarms().length, defects: defects().length }
const r1 = transferAlarms([2, 4], '值班管理员')
check('转单成功', r1.ok && r1.transferred === 2, JSON.stringify(r1.items))
check('告警侧状态已转缺陷', byCode(alarms(), 'ALAR-0002')?.status === '已转缺陷')
check('告警侧记了缺陷编号', /^DEFE-\d{4}$/.test(byCode(alarms(), 'ALAR-0002')?.缺陷编号 ?? ''))
check('缺陷侧多了两条待派发', defects().length === before.defects + 2 &&
  defects().filter((d) => d.来源告警 === 'ALAR-0002' || d.来源告警 === 'ALAR-0004').every((d) => d.status === '待派发'))
check('缺陷台账记了来源', byCode(defects(), byCode(alarms(), 'ALAR-0002').缺陷编号)?.来源告警 === 'ALAR-0002')
check('缺陷台账记了告警来源', String(byCode(defects(), byCode(alarms(), 'ALAR-0002').缺陷编号)?.发现方式).includes('巡视发现'))

// ---- 2. 重复提交只认头一回 ----
const defectCountAfterFirst = defects().length
const r2 = transferAlarms([2], '值班管理员')
check('重复提交不新增缺陷', defects().length === defectCountAfterFirst)
check('重复提交报头一回的单号', r2.items[0]?.repeated === true && r2.items[0]?.defectCode === byCode(alarms(), 'ALAR-0002')?.缺陷编号, JSON.stringify(r2.items))

// ---- 3. 待确认不许直接转（越级拦截，说明还差哪步）----
const r3 = transferAlarms([1], '值班管理员')
check('待确认被拦截', !r3.ok && r3.transferred === 0)
check('提示先确认', r3.items[0]?.message.includes('确认告警'), r3.items[0]?.message)
check('拦截后缺陷数不变', defects().length === defectCountAfterFirst)

// ---- 4. 越权拦截：只有处置人能转 ----
const r4 = transferAlarms([5], '值班管理员')
check('非处置人被拦截', !r4.ok && r4.items[0]?.message.includes('越权'), r4.items[0]?.message)
check('越权提示处置人是谁', r4.items[0]?.message.includes('张工'))
const r4b = transferAlarms([5], '张工')
check('处置人本人可转', r4b.ok && r4b.transferred === 1, JSON.stringify(r4b.items))

// ---- 5. 通用动作不许单独改状态 ----
const r5 = runAction('alarm', 3, '转缺陷单')
check('runAction 拦截转缺陷单', !r5.ok && r5.message.includes('转单面板'))
check('拦截后告警状态没变', byCode(alarms(), 'ALAR-0003')?.status === '待确认')

// ---- 6. 已转缺陷的告警点确认：告知已转过 ----
const r6 = runAction('alarm', 2, '确认告警')
check('已转缺陷不能再确认', !r6.ok && r6.message.includes('已转缺陷') && r6.message.includes('DEFE-'), r6.message)

// ---- 7. 对账：两处条数对得上 ----
const recon = transferReconciliation()
check('对账一致', recon.consistent && recon.alarmTransferred === recon.defectReceived, JSON.stringify(recon))
check('已转条数=种子1+新转3', recon.alarmTransferred === 4, `actual=${recon.alarmTransferred}`)

// ---- 8. 落库失败整笔退回 ----
const realSet = window.localStorage.setItem.bind(window.localStorage)
check('确认告警正常', runAction('alarm', 3, '确认告警').ok)
const defectBefore = JSON.stringify(defects())
window.localStorage.setItem = () => { throw new Error('quota exceeded') }
const r8 = transferAlarms([3], '值班管理员')
window.localStorage.setItem = realSet
check('落库失败整笔退回', !r8.ok && r8.message.includes('整笔已退回'), r8.message)
check('告警侧没留半截', byCode(alarms(), 'ALAR-0003')?.status === '处理中')
check('缺陷侧没留半截', JSON.stringify(defects()) === defectBefore)

// ---- 9. 待确认按发生时间排序 ----
const list = listEntries('alarm')
const pendingTimes = list.items.filter((r) => r.status === '待确认').map((r) => String(r.发生时间))
check('待确认按发生时间升序', pendingTimes.every((t, i) => i === 0 || pendingTimes[i - 1] <= t), pendingTimes.join(','))
check('待确认排在最前', list.items[0]?.status === '待确认')

// ---- 10. 预检不写库 ----
const defectCountBeforePre = defects().length
const pre = precheckTransfer([3], '值班管理员')
check('预检通过且不写库', pre[0]?.ok === true && defects().length === defectCountBeforePre)

// ---- 11. 来源归一化口径 ----
check('来源别名归一', normalizeAlarmSource('监控') === '监控预警' && normalizeAlarmSource('SCADA') === '监控预警')
check('未知来源保留原文', normalizeAlarmSource('无人机巡检') === '无人机巡检')
check('空来源校验失败', normalizeAlarmSource('  ') === '')

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项未通过`)
if (failures > 0) process.exit(1)
