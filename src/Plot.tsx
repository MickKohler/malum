import { useMemo } from "react";
import { compile } from "mathjs";

const WIDTH = 380;
const HEIGHT = 200;
const PAD = { left: 8, right: 8, top: 10, bottom: 18 };
const SAMPLES = 480;

/**if you are actually reading the code, kudos to you :) */
type Props = { expr: string; xMin: number; xMax: number; label: string };

type Curve = { paths: string[]; yMin: number; yMax: number; toX: (x: number) => number; toY: (y: number) => number };

/** Sample the function and return SVG paths. `null` if there is nothing to draw. */
function sample({ expr, xMin, xMax }: Props): Curve | null {
  if (!(xMax > xMin)) return null;
  let fn: (x: number) => unknown;
  try {
    const code = compile(expr);
    fn = (x) => code.evaluate({ x });
  } catch {
    return null;
  }

  const points: [number, number][] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const x = xMin + ((xMax - xMin) * i) / SAMPLES;
    let y = NaN;
    try {
      const value = fn(x);
      if (typeof value === "number") y = value;
    } catch {
      // Undefined at this point, leave a gap.
    }
    points.push([x, y]);
  }

  // y range without outliers (e.g. poles), otherwise the curve gets flattened.
  const ys = points.map((p) => p[1]).filter(Number.isFinite).sort((a, b) => a - b);
  if (ys.length < 2) return null;
  let yMin = ys[Math.floor(ys.length * 0.02)];
  let yMax = ys[Math.ceil(ys.length * 0.98) - 1];
  if (yMax - yMin < 1e-9) {
    yMin -= 1;
    yMax += 1;
  }
  const margin = (yMax - yMin) * 0.08;
  yMin -= margin;
  yMax += margin;

  const toX = (x: number) => PAD.left + ((x - xMin) / (xMax - xMin)) * (WIDTH - PAD.left - PAD.right);
  const toY = (y: number) => PAD.top + ((yMax - y) / (yMax - yMin)) * (HEIGHT - PAD.top - PAD.bottom);

  // Break the path at gaps and at jumps out of the visible range.
  const paths: string[] = [];
  let current = "";
  for (const [x, y] of points) {
    const visible = Number.isFinite(y) && y >= yMin - (yMax - yMin) && y <= yMax + (yMax - yMin);
    if (!visible) {
      if (current) paths.push(current);
      current = "";
      continue;
    }
    current += `${current ? "L" : "M"}${toX(x).toFixed(1)},${toY(y).toFixed(1)}`;
  }
  if (current) paths.push(current);
  return { paths, yMin, yMax, toX, toY };
}

function format(n: number): string {
  return Number(n.toPrecision(3)).toString();
}

export function Plot(props: Props) {
  const curve = useMemo(() => sample(props), [props.expr, props.xMin, props.xMax]);

  if (!curve) {
    return <p className="plot-note">Can't plot: {props.expr}</p>;
  }
  const { paths, yMin, yMax, toX, toY } = curve;
  const showXAxis = yMin < 0 && yMax > 0;
  const showYAxis = props.xMin < 0 && props.xMax > 0;

  return (
    <figure className="plot">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={props.label}>
        <defs>
          <clipPath id="plot-area">
            <rect x={PAD.left} y={PAD.top} width={WIDTH - PAD.left - PAD.right} height={HEIGHT - PAD.top - PAD.bottom} />
          </clipPath>
        </defs>
        {showXAxis && <line className="axis" x1={PAD.left} x2={WIDTH - PAD.right} y1={toY(0)} y2={toY(0)} />}
        {showYAxis && <line className="axis" x1={toX(0)} x2={toX(0)} y1={PAD.top} y2={HEIGHT - PAD.bottom} />}
        <g clipPath="url(#plot-area)">
          {paths.map((d, i) => (
            <path key={i} className="curve" d={d} />
          ))}
        </g>
        <text className="tick" x={PAD.left} y={HEIGHT - 4}>
          {format(props.xMin)}
        </text>
        <text className="tick" x={WIDTH - PAD.right} y={HEIGHT - 4} textAnchor="end">
          {format(props.xMax)}
        </text>
        <text className="tick" x={PAD.left + 2} y={PAD.top + 9}>
          {format(yMax)}
        </text>
        <text className="tick" x={PAD.left + 2} y={HEIGHT - PAD.bottom - 3}>
          {format(yMin)}
        </text>
      </svg>
      <figcaption>{props.label}</figcaption>
    </figure>
  );
}
