"use client";

import { useId, useState } from "react";
import { deviceLocalIsoTimestamp } from "@/modules/fulfillment/device-time";
import styles from "./packets.module.css";

const SENT_TIME_PATTERN = "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:[.][0-9]{1,3})?)?(?:Z|(?:[+]|-)[0-9]{2}:[0-9]{2})";

export function DeviceTimeField() {
  const inputId = useId();
  const helpId = useId();
  const [value, setValue] = useState("");
  const [announcement, setAnnouncement] = useState("");

  function fillDeviceTime() {
    setValue(deviceLocalIsoTimestamp(new Date()));
    setAnnouncement("Device time filled. Check that it matches when the email was actually sent.");
  }

  return <>
    <label htmlFor={inputId}>Actual sent time (ISO 8601, including timezone)</label>
    <div className={styles.timestampField}>
      <input
        id={inputId}
        name="sentAt"
        type="text"
        value={value}
        onChange={(event) => { setValue(event.target.value); setAnnouncement(""); }}
        placeholder="2026-11-10T14:30:00+06:00"
        pattern={SENT_TIME_PATTERN}
        required
        maxLength={35}
        aria-describedby={helpId}
      />
      <button className={styles.timestampButton} type="button" onClick={fillDeviceTime}>
        Use current device time
      </button>
    </div>
    <p className={styles.muted} id={helpId}>Use the actual time the email was sent. The button uses this device’s local time and timezone; check it before saving. The time must be after the reservation began.</p>
    {announcement ? <p className={styles.timestampStatus} role="status" aria-live="polite">{announcement}</p> : null}
  </>;
}
