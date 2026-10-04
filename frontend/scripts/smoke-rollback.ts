// 回滚测试：模拟 localStorage 写不进去，验证转单整笔退回。
// 注意要在导入数据层之前把 window 装好。
const store = new Map<string, string>()
let writable = true
;(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (!writable) {
        throw new Error('QuotaExceededError')
      }
      store.set(k, v)
    },
    removeItem: (k: string) => store.delete(k),
  },
}

const { transferAlarmsToDefects, transferLedger } = await import('@/api/local-service')
const { listRows } = await import('@/data/local-store')

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`ok   ${name}`)
  } else {
    failures += 1
    console.log(`FAIL ${name}`, extra ?? '')
  }
}

// 先正常转一笔，确认存储链路可用
const warm = transferAlarmsToDefects([2], '值班管理员')
check('存储正常时能转单', warm.ok, warm)

// 存储写不进去：整笔退回，两处都不许动
writable = false
const before = { alarms: listRows('alarm').length, defects: listRows('defect').length, ledger: transferLedger() }
const failed = transferAlarmsToDefects([4], '值班管理员')
check('落库失败返回失败', !failed.ok && failed.message.includes('整笔退回'), failed)
check('告警状态没动', listRows('alarm').find((r) => r.id === 4)!.status === '处理中')
check('缺陷台账没动', listRows('defect').length === before.defects)
check('对账仍一致', transferLedger().matched && transferLedger().alarmTransferred === before.ledger.alarmTransferred)

// 存储恢复后同一笔还能再转（失败不留半截状态）
writable = true
const retry = transferAlarmsToDefects([4], '值班管理员')
check('恢复后重转成功', retry.ok, retry)
check('重转后两处对得上', transferLedger().matched, transferLedger())

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
