// 冒烟测试：在 node 里跑转单逻辑（local-store 在无 window 时走内存缓存）。
import {
  listAlarmEntries,
  listEntries,
  precheckTransfer,
  runAction,
  transferAlarmsToDefects,
  transferLedger,
} from '@/api/local-service'
import { listRows, saveRows } from '@/data/local-store'

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`ok   ${name}`)
  } else {
    failures += 1
    console.log(`FAIL ${name}`, extra ?? '')
  }
}

const OPERATOR = '值班管理员'

// 1. 待确认按发生时间升序排在前面
const listed = listAlarmEntries()
const pendingTimes = listed.items.filter((r) => r.status === '待确认').map((r) => String(r['发生时间']))
check('待确认按发生时间升序', pendingTimes.join() === [...pendingTimes].sort().join(), pendingTimes)
check('待确认排在列表最前', listed.items[0].status === '待确认' && listed.items[1].status === '待确认')

// 2. 越级拦截：待确认不许直接转，且说明还差哪一步
const pre = precheckTransfer([1], OPERATOR)
check('待确认转单被拦截', !pre[0].ok && pre[0].reason!.includes('确认告警'), pre[0])
const jump = transferAlarmsToDefects([1], OPERATOR)
check('待确认转单不落库', !jump.ok && listRows('alarm').find((r) => r.id === 1)!.status === '待确认')
check('拦截后缺陷台账没动', listRows('defect').length === 3)

// 3. 越权拦截：只有本条告警的处置人能转
const denied = transferAlarmsToDefects([2], '别人')
check('非处置人转单被拦截', !denied.ok && denied.items[0].reason!.includes('值班管理员'), denied.items[0])

// 4. 正常转单：一次落两处
const before = transferLedger()
const done = transferAlarmsToDefects([2], OPERATOR)
const alarm2 = listRows('alarm').find((r) => r.id === 2)!
const defect = listRows('defect').find((r) => r['来源告警编号'] === 'ALAR-0002')
check('转单成功', done.ok, done)
check('告警状态与缺陷单号一起写', alarm2.status === '已转缺陷' && alarm2['缺陷单号'] === 'DEFE-0004', alarm2)
check('告警状态字段同步', alarm2['告警状态'] === '已转缺陷')
check(
  '缺陷落入待派发台账且来源记下',
  !!defect && defect.status === '待派发' && defect['发现方式'] === '人工巡检' && defect['严重等级'] === '严重',
  defect,
)
const after = transferLedger()
check('两处已转条数对得上', after.matched && after.alarmTransferred === before.alarmTransferred + 1, after)

// 5. 重复提交只认头一回
const again = transferAlarmsToDefects([2], OPERATOR)
check('重复转单沿用首次单号', again.ok && again.items[0].reused && again.items[0].defectNo === 'DEFE-0004', again.items[0])
check('没有重复开缺陷单', listRows('defect').filter((r) => r['来源告警编号'] === 'ALAR-0002').length === 1)

// 6. 已转缺陷的告警不能再确认/恢复
const confirmAgain = runAction('alarm', 2, '确认告警')
check('已转缺陷不能再确认', !confirmAgain.ok && confirmAgain.message.includes('已转缺陷'), confirmAgain)
const recover = runAction('alarm', 2, '登记恢复')
check('已转缺陷不能登记恢复', !recover.ok && recover.message.includes('缺陷'), recover)

// 7. 通用动作不许单独改状态走转单
const direct = runAction('alarm', 4, '转缺陷单')
check('runAction 拒绝单独转单', !direct.ok && listRows('alarm').find((r) => r.id === 4)!.status === '处理中')

// 8. 批量：按条核对，可转的落单、越权的拦截
const batch = transferAlarmsToDefects([4, 5], OPERATOR)
check('批量部分成功', batch.ok, batch)
check('越权那条被拦截并说明', batch.items.find((i) => i.alarmNo === 'ALAR-0005')!.reason!.includes('巡检员张三'))
const ledger2 = transferLedger()
check('批量后两处仍对得上', ledger2.matched && ledger2.alarmTransferred === 2 && ledger2.defectFromAlarm === 2, ledger2)

// 9. 确认告警正常流转，且状态字段同步
const confirm1 = runAction('alarm', 1, '确认告警')
const alarm1 = listRows('alarm').find((r) => r.id === 1)!
check('确认告警流转', confirm1.ok && alarm1.status === '处理中' && alarm1['告警状态'] === '处理中', alarm1)

// 10. 兼容既有记录：旧数据 已转缺陷但缺陷没落库 → 补开修平；待确认缺发生时间 → 补齐
const legacyAlarms = listRows('alarm').map((r) => ({ ...r }))
legacyAlarms.push({
  id: 99,
  status: '已转缺陷',
  pending: false,
  abnormal: false,
  告警编号: 'ALAR-0099',
  告警等级: '告警事件样例99',
  告警来源: '告警事件样例99',
  发生时间: '',
  持续时长: '样例',
  关联设备: '样例设备',
  处置人员: '告警事件样例99',
  告警状态: '已转缺陷',
})
legacyAlarms.push({
  id: 100,
  status: '待确认',
  pending: true,
  abnormal: false,
  告警编号: 'ALAR-0100',
  告警等级: '一般',
  告警来源: 'SCADA监控',
  发生时间: '',
  持续时长: '样例',
  关联设备: '样例设备',
  处置人员: '值班管理员',
  告警状态: '待确认',
})
saveRows('alarm', legacyAlarms)
const repaired = transferAlarmsToDefects([99], OPERATOR)
const repairDefect = listRows('defect').find((r) => r['来源告警编号'] === 'ALAR-0099')
check('旧记录已转但缺缺陷单 → 补开修平', repaired.ok && !!repairDefect && repairDefect.status === '待派发', repairDefect)
check('修平后两处仍对得上', transferLedger().matched, transferLedger())
const relisted = listAlarmEntries()
const legacy100 = relisted.items.find((r) => Number(r.id) === 100)!
check('待确认缺发生时间已补齐', String(legacy100['发生时间']).trim() !== '', legacy100['发生时间'])

// 11. 缺陷模块列表不受影响、来源告警可查
const defects = listEntries('defect')
check('缺陷列表含转单记录', defects.items.some((r) => String(r['来源告警编号']) === 'ALAR-0002'))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
