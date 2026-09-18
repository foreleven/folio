import { Schema } from 'effect'
import { RoutineRecord } from './routine'
import { describe, expect, it } from 'vitest'
import { previousRoutineDate, routineDateAt, routineDayEnd, routineDateState, routineGapDates } from './routine'

describe('Routine civil dates', () => {
  it('includes unprocessed dates before the first run and after the last run in the Routine timezone', () => {
    const record = { createdAt: Date.parse('2026-09-10T12:00:00Z'), timeZone: 'Pacific/Kiritimati' }
    const at = Date.parse('2026-09-13T11:00:00Z') // Local date is September 14.
    expect(routineGapDates(record, [], at)).toEqual(['2026-09-11', '2026-09-12', '2026-09-13'])
    expect(routineGapDates(record, [{ routineDate: '2026-09-12', isEnd: true, status: 'succeeded' }], at))
      .toEqual(['2026-09-11', '2026-09-13'])
    expect(routineGapDates({ createdAt: at, timeZone: record.timeZone }, [], at)).toEqual([])
  })

  it('only marks a day complete after a successful day-close receipt', () => {
    expect(routineDateState([{ isEnd: false, status: 'succeeded' }])).toBe('progress')
    expect(routineDateState([{ isEnd: true, status: 'pending' }])).toBe('progress')
    expect(routineDateState([{ isEnd: true, status: 'failed' }])).toBe('attention')
    expect(routineDateState([{ isEnd: false, status: 'failed' }, { isEnd: true, status: 'succeeded' }])).toBe('success')
  })

  it.each(['UTC', 'Asia/Shanghai', 'Pacific/Kiritimati', 'Pacific/Auckland', 'America/New_York'])(
    'finds the preceding calendar date in %s', timeZone => {
      expect(previousRoutineDate('2026-01-01', timeZone)).toBe('2025-12-31')
      expect(previousRoutineDate('2026-03-09', timeZone)).toBe('2026-03-08')
      expect(previousRoutineDate('2026-11-02', timeZone)).toBe('2026-11-01')
    }
  )

  it('rejects invalid time zones before storing a Routine', () => {
    expect(() => Schema.decodeUnknownSync(RoutineRecord.fields.timeZone)('Invalid/Zone')).toThrow()
    expect(Schema.decodeUnknownSync(RoutineRecord.fields.timeZone)('Asia/Shanghai')).toBe('Asia/Shanghai')
  })

  it('uses local day boundaries across DST changes', () => {
    const zone = 'America/New_York'
    const spring = routineDayEnd('2026-03-08', zone)
    const autumn = routineDayEnd('2026-11-01', zone)
    expect(spring - routineDayEnd('2026-03-07', zone)).toBe(23 * 60 * 60 * 1000)
    expect(autumn - routineDayEnd('2026-10-31', zone)).toBe(25 * 60 * 60 * 1000)
    expect(routineDateAt(spring, zone)).toBe('2026-03-08')
    expect(routineDateAt(spring + 1, zone)).toBe('2026-03-09')
  })
})
