// Adapted from Vercel AI Elements (Apache-2.0):
// https://github.com/vercel/ai-elements/blob/main/packages/elements/src/connection.tsx
import type { ConnectionLineComponent } from '@xyflow/react';

const HALF = 0.5;

export const Connection: ConnectionLineComponent = ({
  fromX,
  fromY,
  toX,
  toY,
}) => (
  <g>
    <path
      className="animated"
      d={`M${fromX},${fromY} C ${fromX + (toX - fromX) * HALF},${fromY} ${fromX + (toX - fromX) * HALF},${toY} ${toX},${toY}`}
      fill="none"
      stroke="var(--color-neutral-400, #a3a3a3)"
      strokeWidth={1}
    />
    <circle
      cx={toX}
      cy={toY}
      fill="#fff"
      r={3}
      stroke="var(--color-neutral-400, #a3a3a3)"
      strokeWidth={1}
    />
  </g>
);
