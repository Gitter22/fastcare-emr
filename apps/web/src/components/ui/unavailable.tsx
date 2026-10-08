import * as React from "react";
import { Tooltip } from "./menu";

/**
 * A control that can't work yet because an external system isn't connected (or a prior step is missing): shown
 * disabled, never hidden or faked, with the reason on hover/focus and to screen readers. Role restrictions are
 * different: those controls are hidden (NAV-09).
 */
export function Unavailable({
  reason,
  children,
  testId,
}: {
  reason: string;
  children: React.ReactNode;
  testId?: string;
}) {
  const id = React.useId();
  return (
    <Tooltip content={reason}>
      <span
        tabIndex={0}
        aria-describedby={id}
        className="inline-flex"
        data-testid={testId}
        data-unavailable=""
      >
        {children}
        <span id={id} className="sr-only">
          {reason}
        </span>
      </span>
    </Tooltip>
  );
}
