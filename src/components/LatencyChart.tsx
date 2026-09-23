/**
 * Multi-series line chart for engine-tier comparison.
 *
 * Hand-rolled SVG rather than a charting library: the app's only chart is this
 * one shape, and @criblio/app-utils lists its d3 dependencies as optional peers
 * (they are not installed), so pulling in a chart stack would add a dependency
 * tree for one figure.
 *
 * Design decisions worth keeping:
 *   - Series color is an ORDINAL ramp, because engine tiers are an ordered
 *     progression. Larger tier = more prominent step. Color follows the tier,
 *     never the rank of its result, so filtering tiers never repaints the rest.
 *   - One y-axis. Comparing two measures of different scale (seconds vs
 *     ms-per-hour) is done by switching the metric, never by a second axis.
 *   - A legend is always present, and end labels are added only when they do
 *     not collide; when lines converge at the right edge the labels are dropped
 *     rather than stacked away from their lines.
 *   - Every value in the tooltip is also in the page's table view, so the hover
 *     layer enhances and never gates.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import s from './LatencyChart.module.css';

export interface ChartSeries {
  key: string;
  label: string;
  /** One value per x position; null where that pair was not measured. */
  values: (number | null)[];
  /** CSS color, normally a `var(--chart-n)` step. */
  color: string;
}

export interface LatencyChartProps {
  xLabels: string[];
  /** Secondary x tick line, e.g. the window span. */
  xSubLabels?: string[];
  series: ChartSeries[];
  yAxisTitle: string;
  /** Formats a value for ticks, labels and the tooltip. */
  format: (value: number) => string;
  /** Screen-reader summary of what is plotted. */
  ariaLabel: string;
  height?: number;
}

const MARGIN = { top: 26, right: 96, bottom: 42, left: 62 };
const Y_TICKS = 5;
/** Below this vertical gap, two end labels would read as noise. */
const LABEL_MIN_GAP = 16;

/** Round axis bounds up to a clean 1 / 2 / 2.5 / 5 x 10^n step. */
function niceStep(rough: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const snapped = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return snapped * magnitude;
}

function yScaleTicks(max: number): { ticks: number[]; top: number; step: number } {
  if (!(max > 0)) return { ticks: [0, 1], top: 1, step: 1 };
  const step = niceStep(max / Y_TICKS);
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(value);
  return { ticks, top, step };
}

/**
 * Axis ticks are formatted from the STEP, not per value, so the column reads as
 * one scale: a step of 50 gives 0 / 50 / 100, never 0.00 / 50.0 / 100. The
 * value formatter stays with the tooltip, where precision is what's wanted.
 */
function tickFormatter(step: number): (value: number) => string {
  const decimals = step >= 10 ? 0 : step >= 1 ? 1 : 2;
  return (value) => value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export default function LatencyChart({
  xLabels,
  xSubLabels,
  series,
  yAxisTitle,
  format,
  ariaLabel,
  height = 320,
}: LatencyChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(860);
  const [active, setActive] = useState<number | null>(null);

  // Responsive width without a layout read during render.
  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      if (measured > 0) setWidth(measured);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const innerWidth = Math.max(120, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(80, height - MARGIN.top - MARGIN.bottom);

  const hasData = series.some((item) => item.values.some((value) => value !== null));

  const max = useMemo(() => {
    let found = 0;
    for (const item of series) {
      for (const value of item.values) if (value !== null && value > found) found = value;
    }
    return found;
  }, [series]);

  const { ticks, top, step } = useMemo(() => yScaleTicks(max), [max]);
  const formatTick = useMemo(() => tickFormatter(step), [step]);

  const xAt = useCallback(
    (index: number) =>
      MARGIN.left + (xLabels.length < 2 ? innerWidth / 2 : (index * innerWidth) / (xLabels.length - 1)),
    [innerWidth, xLabels.length],
  );
  const yAt = useCallback(
    (value: number) => MARGIN.top + innerHeight - (value / top) * innerHeight,
    [innerHeight, top],
  );

  /** Split each series at nulls so a gap is a gap, not an interpolated line. */
  const paths = useMemo(
    () =>
      series.map((item) => {
        const segments: string[] = [];
        let current: string[] = [];
        item.values.forEach((value, index) => {
          if (value === null) {
            if (current.length) segments.push(current.join(' '));
            current = [];
            return;
          }
          current.push(`${current.length ? 'L' : 'M'}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`);
        });
        if (current.length) segments.push(current.join(' '));
        return { key: item.key, d: segments.join(' ') };
      }),
    [series, xAt, yAt],
  );

  /**
   * End labels for the series that have room for one. Nudging converging labels
   * apart detaches them from their lines, so a label whose nearest neighbour is
   * closer than LABEL_MIN_GAP is dropped rather than moved — the legend already
   * carries identity for it. Only the crowded pair loses its label, not the
   * whole set.
   */
  const endLabels = useMemo(() => {
    const candidates = series
      .map((item) => {
        for (let index = item.values.length - 1; index >= 0; index -= 1) {
          const value = item.values[index];
          if (value !== null) return { key: item.key, label: item.label, index, value };
        }
        return null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const positions = candidates.map((entry) => yAt(entry.value));
    return candidates.filter((_, index) =>
      positions.every(
        (other, otherIndex) =>
          otherIndex === index || Math.abs(other - positions[index]) >= LABEL_MIN_GAP,
      ),
    );
  }, [series, yAt]);

  const move = useCallback(
    (clientX: number) => {
      const node = wrapRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const offset = clientX - rect.left - MARGIN.left;
      const step = xLabels.length < 2 ? innerWidth : innerWidth / (xLabels.length - 1);
      const index = Math.round(offset / step);
      setActive(Math.min(xLabels.length - 1, Math.max(0, index)));
    },
    [innerWidth, xLabels.length],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      setActive((current) => {
        const next = (current ?? 0) + (event.key === 'ArrowRight' ? 1 : -1);
        return Math.min(xLabels.length - 1, Math.max(0, next));
      });
    },
    [xLabels.length],
  );

  if (!hasData) {
    return (
      <div className={s.empty}>
        No measured runs yet — the chart appears once a window has at least one successful run.
      </div>
    );
  }

  const activeRows =
    active === null
      ? []
      : series
          .map((item) => ({ ...item, value: item.values[active] }))
          .filter((item): item is ChartSeries & { value: number } => item.value !== null);

  // Keep the tooltip inside the wrapper: flip it to the left of the crosshair
  // once the pointer passes the midpoint.
  const tooltipX = active === null ? 0 : xAt(active);
  const flip = tooltipX > MARGIN.left + innerWidth / 2;

  return (
    <div className={s.wrap} ref={wrapRef}>
      <div className={s.legend}>
        {series.map((item) => (
          <span className={s.legendItem} key={item.key}>
            <span className={s.legendKey} style={{ background: item.color }} />
            {item.label}
          </span>
        ))}
      </div>

      <svg
        className={s.svg}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onPointerMove={(event) => move(event.clientX)}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((current) => current ?? xLabels.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={onKeyDown}
      >
        {ticks.map((value) => (
          <g key={value}>
            <line
              className={s.grid}
              x1={MARGIN.left}
              x2={MARGIN.left + innerWidth}
              y1={yAt(value)}
              y2={yAt(value)}
            />
            <text className={`${s.tick} ${s.tickY}`} x={MARGIN.left - 8} y={yAt(value) + 4}>
              {formatTick(value)}
            </text>
          </g>
        ))}

        {/* Left-aligned above the plot, clear of the topmost tick label. */}
        <text className={s.axisTitle} x={0} y={12}>
          {yAxisTitle}
        </text>

        {active !== null && (
          <line
            className={s.crosshair}
            x1={xAt(active)}
            x2={xAt(active)}
            y1={MARGIN.top}
            y2={MARGIN.top + innerHeight}
          />
        )}

        {xLabels.map((label, index) => (
          <g key={label}>
            <text className={`${s.tick} ${s.tickX}`} x={xAt(index)} y={MARGIN.top + innerHeight + 18}>
              {label}
            </text>
            {xSubLabels?.[index] && (
              <text className={s.tickXSub} x={xAt(index)} y={MARGIN.top + innerHeight + 32}>
                {xSubLabels[index]}
              </text>
            )}
          </g>
        ))}

        {paths.map((path, index) => (
          <path key={path.key} className={s.line} d={path.d} stroke={series[index].color} />
        ))}

        {series.map((item) =>
          item.values.map((value, index) =>
            value === null ? null : (
              <circle
                key={`${item.key}-${index}`}
                className={active === index ? s.markerActive : s.marker}
                cx={xAt(index)}
                cy={yAt(value)}
                r={4}
                fill={item.color}
              />
            ),
          ),
        )}

        {endLabels.map((entry) => (
          <text
            className={s.endLabel}
            key={entry.key}
            x={xAt(entry.index) + 10}
            y={yAt(entry.value) + 4}
          >
            {entry.label}
          </text>
        ))}
      </svg>

      {active !== null && activeRows.length > 0 && (
        <div
          className={s.tooltip}
          style={{
            left: flip ? undefined : tooltipX + 14,
            right: flip ? width - tooltipX + 14 : undefined,
            top: MARGIN.top,
          }}
        >
          <div className={s.tooltipHead}>
            {xLabels[active]}
            {xSubLabels?.[active] && <span className={s.tooltipSub}> · {xSubLabels[active]}</span>}
          </div>
          {activeRows.map((row) => (
            <div className={s.tooltipRow} key={row.key}>
              <span className={s.legendKey} style={{ background: row.color }} />
              <span className={s.tooltipName}>{row.label}</span>
              <span className={s.tooltipValue}>{format(row.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
