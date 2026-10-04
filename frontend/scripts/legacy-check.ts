// 既有记录兼容：localStorage 里先放老版数据（缺缺陷编号、缺发生时间、已转缺陷但台账缺单），
// 再动态加载服务，验证读取时补齐、重转补单。
const store = new Map<string, string>()
const legacy = {
  alarm: [
    { id: 1, status: '处理中', pending: true, abnormal: false, 告警编号: 'ALAR-1001', 告警等级: '二级', 告警来源: '监控', 关联设备: 'INVE-0001', 处置人员: '值班管理员' },
    { id: 2, status: '已转缺陷', pending: false, abnormal: false, 告警编号: 'ALAR-1002', 告警等级: '一级', 告警来源: '监控预警', 发生时间: '2026-09-20 08:00', 关联设备: 'INVE-0002', 处置人员: '值班管理员', 缺陷编号: 'DEFE-0007' },
    { id: 3, status: '待确认', pending: true, abnormal: false, 告警编号: 'ALAR-1003', 告警等级: '三级', 告警来源: '', 关联设备: 'COMB-0001', 处置人员: '值班管理员' },
  ],
  defect: [],
}
store.set('pv-plant-ops:entries', JSON.stringify(legacy))
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
}

let failures = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name} ${extra}`)
  }
}

const { listEntries, transferAlarms, transferReconciliation } = await import('@/api/local-service')
const { listRows } = await import('@/data/local-store')

// 缺发生时间的老记录被补齐，待确认按时间排前
const list = listEntries('alarm')
const legacy1 = list.items.find((r) => r.告警编号 === 'ALAR-1001')
const legacy3 = list.items.find((r) => r.告警编号 === 'ALAR-1003')
check('缺发生时间已补齐', String(legacy1?.发生时间 ?? '').trim() !== '', String(legacy1?.发生时间))
check('缺缺陷编号已补空串', typeof legacy1?.缺陷编号 === 'string')
check('待确认排最前', list.items[0]?.告警编号 === 'ALAR-1003')

// 老数据「已转缺陷但台账缺单」：允许重转补齐，沿用原编号 DEFE-0007
const r1 = transferAlarms([2], '值班管理员')
check('半截账重转补齐', r1.ok && r1.transferred === 1, JSON.stringify(r1.items))
check('沿用原缺陷编号', r1.items[0]?.defectCode === 'DEFE-0007', JSON.stringify(r1.items))
const defect7 = listRows('defect').find((d) => d.缺陷编号 === 'DEFE-0007')
check('台账补上 DEFE-0007 且回指来源告警', defect7?.来源告警 === 'ALAR-1002')

// 老来源「监控」归一化后落台账
const r2 = transferAlarms([1], '值班管理员')
check('老记录可转', r2.ok, JSON.stringify(r2.items))
const defectNew = listRows('defect').find((d) => d.来源告警 === 'ALAR-1001')
check('来源归一落入发现方式', String(defectNew?.发现方式).includes('监控预警'), String(defectNew?.发现方式))

// 缺来源的老记录：先确认再转，被拦在来源校验上
const { runAction } = await import('@/api/local-service')
check('确认告警', runAction('alarm', 3, '确认告警').ok)
const r3 = transferAlarms([3], '值班管理员')
check('缺来源被拦截', !r3.ok && r3.items[0]?.message.includes('来源'), r3.items[0]?.message)

// 对账：两笔转单两边条数对得上
const recon = transferReconciliation()
check('对账一致', recon.consistent && recon.alarmTransferred === 2 && recon.defectReceived === 2, JSON.stringify(recon))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项未通过`)
if (failures > 0) process.exit(1)
