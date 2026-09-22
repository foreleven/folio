import { Schema } from 'effect'
import { RoutineTimeZone } from './routine'
import { describe, expect, it } from 'vitest'
import { previousRoutineDate, routineDateAt, routineDayStart, routineDateState, routineTimestampAt } from './routine'

describe('Routine civil dates', () => {
  it('only marks observed windows as requiring attention, without inferring day completion', () => {
    expect(routineDateState([{ status: 'succeeded' }])).toBe('progress')
    expect(routineDateState([{ status: 'pending' }])).toBe('progress')
    expect(routineDateState([{ status: 'failed' }])).toBe('attention')
    expect(routineDateState([{ status: 'failed' }, { status: 'succeeded' }])).toBe('attention')
  })

  it.each(['UTC', 'Asia/Shanghai', 'Pacific/Kiritimati', 'Pacific/Auckland', 'America/New_York'])(
    'finds the preceding calendar date in %s', timeZone => {
      expect(previousRoutineDate('2026-01-01', timeZone)).toBe('2025-12-31')
      expect(previousRoutineDate('2026-03-09', timeZone)).toBe('2026-03-08')
      expect(previousRoutineDate('2026-11-02', timeZone)).toBe('2026-11-01')
    }
  )

  it('rejects invalid time zones before storing a Routine', () => {
    expect(() => Schema.decodeUnknownSync(RoutineTimeZone)('Invalid/Zone')).toThrow()
    expect(Schema.decodeUnknownSync(RoutineTimeZone)('Asia/Shanghai')).toBe('Asia/Shanghai')
  })

  it('uses local day boundaries across DST changes', () => {
    const zone = 'America/New_York'
    const spring = routineDayStart('2026-03-09', zone) - 1
    const autumn = routineDayStart('2026-11-02', zone) - 1
    expect(spring + 1 - routineDayStart('2026-03-08', zone)).toBe(23 * 60 * 60 * 1000)
    expect(autumn + 1 - routineDayStart('2026-11-01', zone)).toBe(25 * 60 * 60 * 1000)
    expect(routineDateAt(spring, zone)).toBe('2026-03-08')
    expect(routineDateAt(spring + 1, zone)).toBe('2026-03-09')
  })

  it('formats execution instants with the Routine timezone offset', () => {
    expect(routineTimestampAt(Date.parse('2026-09-20T16:00:00Z'), 'Asia/Shanghai'))
      .toBe('2026-09-21T00:00:00.000+08:00')
    expect(routineTimestampAt(Date.parse('2026-01-15T17:00:00Z'), 'America/New_York'))
      .toBe('2026-01-15T12:00:00.000-05:00')
    expect(routineTimestampAt(Date.parse('2026-07-15T16:00:00Z'), 'America/New_York'))
      .toBe('2026-07-15T12:00:00.000-04:00')
  })
})
