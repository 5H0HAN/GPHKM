"use client";

import { useEffect, useRef } from "react";

/** Move focus after a user changes steps, without stealing it on page load. */
export function useStepHeading(step: string) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousStepRef = useRef(step);
  useEffect(() => {
    if (previousStepRef.current !== step) {
      previousStepRef.current = step;
      headingRef.current?.focus();
    }
  }, [step]);
  return headingRef;
}
