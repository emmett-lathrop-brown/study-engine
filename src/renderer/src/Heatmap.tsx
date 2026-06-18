import { useMemo } from 'react'
import type { DayCount } from '../../engine/types'
import { addDays, todayISO } from '../../engine/srs'
import { InfoTip } from './InfoTip'

// GitHub-style contribution grid: WEEKS columns of 7 days (Sun..Sat), the
// rightmost column being the current week. The engine hands us only the non-zero
// days (StudyStats.dailyCounts); we fill the empty days here so presentation
// (grid shape, colour buckets) stays out of the engine.
const WEEKS = 26 // ~6 months of history shown (tunable)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Intensity bucket (0..4) for a day's review count.
function level(count: number): number {
  if (count <= 0) return 0
  if (count <= 2) return 1
  if (count <= 5) return 2
  if (count <= 9) return 3
  return 4
}

// Local weekday (0=Sun..6=Sat) of a YYYY-MM-DD string — built from local parts so
// it never drifts a day across timezones (unlike new Date('YYYY-MM-DD') = UTC).
function dow(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).getDay()
}

interface Cell {
  day: string
  count: number
  future: boolean // days after today in the current partial week — rendered blank
}

export function Heatmap({ daily }: { daily: DayCount[] }): JSX.Element {
  const today = todayISO()
  const weeks = useMemo(() => {
    const counts = new Map(daily.map((d) => [d.day, d.count]))
    // Start at the Sunday of the oldest shown week so every column is a full Sun..Sat.
    const start = addDays(today, -dow(today) - (WEEKS - 1) * 7)
    const out: Array<{ monthLabel: string | null; days: Cell[] }> = []
    let cur = start
    let lastMonth = -1
    for (let w = 0; w < WEEKS; w++) {
      const days: Cell[] = []
      let monthLabel: string | null = null
      for (let r = 0; r < 7; r++) {
        // Label a column only at a month's FIRST Sunday (day-of-month <= 7). For
        // interior columns this is exactly where the month number changes anyway;
        // the day<=7 guard additionally stops the leftmost column from labelling a
        // month's *tail* week (col0 has no real predecessor), which would paint a
        // label that overlaps the next column's. Advance lastMonth every Sunday.
        if (r === 0) {
          const mo = Number(cur.slice(5, 7)) - 1
          if (mo !== lastMonth && Number(cur.slice(8, 10)) <= 7) monthLabel = MONTHS[mo]
          lastMonth = mo
        }
        days.push({ day: cur, count: counts.get(cur) ?? 0, future: cur > today })
        cur = addDays(cur, 1)
      }
      out.push({ monthLabel, days })
    }
    return out
  }, [daily, today])

  return (
    <div className="heatmap">
      <div className="heatmap-head">
        <span className="hm-title">
          学習ヒートマップ（直近{WEEKS}週）
          <InfoTip term="学習ヒートマップ">
            日ごとの学習量をマスの色の濃さで表したカレンダー。濃いマスほど、その日たくさん復習したことを表します。
          </InfoTip>
        </span>
        <span className="heatmap-legend">
          少
          <span className="hm-cell l0" />
          <span className="hm-cell l1" />
          <span className="hm-cell l2" />
          <span className="hm-cell l3" />
          <span className="hm-cell l4" />多
        </span>
      </div>
      <div className="heatmap-cols">
        {weeks.map((wk, i) => (
          <div key={i} className="hm-col">
            <span className="hm-col-month">{wk.monthLabel ?? ''}</span>
            {wk.days.map((c) =>
              c.future ? (
                <span key={c.day} className="hm-cell future" />
              ) : (
                <span key={c.day} className={`hm-cell l${level(c.count)}`} title={`${c.day}・${c.count}回`} />
              )
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
