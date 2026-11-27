'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A heading that takes the focus when it first appears, so someone who chose a workload on the map
 * lands on what it opened. Later renders from the change stream keep it mounted and leave the focus be.
 */
export function FocusHeading({ id, className, children }: { id: string; className: string; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <h2 ref={heading} id={id} className={className} tabIndex={-1}>
      {children}
    </h2>
  );
}
