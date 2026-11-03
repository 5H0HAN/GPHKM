"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { canApplyOperationsRefresh, hasActionableOperations, operationsCountLabel, OPERATIONS_INBOX_REFRESH_MS, shouldRefreshOperationsInbox, type OperationsAlert, type OperationsWorkItem } from "@/modules/observability/operations-inbox";
import { setOverviewAttentionDone } from "@/server/observability/attention-actions";
import styles from "./staff.module.css";

type OverviewRefreshResponse = { alerts: OperationsAlert[]; checkedAt: string };

function checkedTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function taskVersionKey(item: OperationsWorkItem) {
  return JSON.stringify([item.key, item.version ?? null]);
}

function OverviewTask({ item, done, showDone, onDoneChange, onMessage, onRefresh }: {
  item: OperationsWorkItem;
  done: boolean;
  showDone: boolean;
  onDoneChange: (item: OperationsWorkItem, done: boolean) => void;
  onMessage: (message: string) => void;
  onRefresh: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  if (done && !showDone) return null;

  const nextDone = !done;
  const updateDone = () => {
    if (!item.version) {
      setError("This item is missing its current version. Refresh Overview and try again.");
      return;
    }
    setError("");
    startTransition(async () => {
      const result = await setOverviewAttentionDone(item.key, item.version!, nextDone);
      if (!result.ok) {
        setError(result.message);
        onRefresh();
        return;
      }
      onDoneChange(item, nextDone);
      onMessage(nextDone
        ? "Done saved. This preview is hidden from your Overview; its workflow remains open until updated there."
        : "Preview restored to your Overview.");
    });
  };

  return (
    <li className={styles.task}>
      <div className={styles.taskCopy}>
        <strong>{item.title}</strong>
        <span>{item.detail}</span>
        {item.updatedAt && <time dateTime={item.updatedAt}>{item.dateLabel ?? "Updated"} {checkedTime(item.updatedAt)}</time>}
        {error && <span className={styles.taskError} role="alert">{error}</span>}
      </div>
      <div className={styles.taskActions}>
        <Link className={styles.cardAction} href={item.href}>{item.action}</Link>
        <button className={styles.doneAction} type="button" onClick={updateDone} disabled={pending} aria-label={done ? `Restore ${item.title} to your Overview` : `Mark ${item.title} done for your Overview`}>
          {pending ? "Saving…" : done ? "Undo" : "Done"}
        </button>
      </div>
    </li>
  );
}

export function OverviewInbox({ initialAlerts, initialCheckedAt }: { initialAlerts: OperationsAlert[]; initialCheckedAt: string }) {
  const [alerts, setAlerts] = useState(initialAlerts);
  const [checkedAt, setCheckedAt] = useState(initialCheckedAt);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [accessExpired, setAccessExpired] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [doneOverrides, setDoneOverrides] = useState<Record<string, boolean>>({});
  const [attentionMessage, setAttentionMessage] = useState("");
  const inFlightRef = useRef(false);
  const attentionMutationRevisionRef = useRef(0);
  const initialCheckedMs = Date.parse(initialCheckedAt);
  const hasOpenWork = hasActionableOperations(alerts);
  const activeAlerts = alerts.filter((alert) => alert.count > 0);
  const doneCount = alerts.reduce((sum, alert) => sum + alert.items.filter((item) => doneOverrides[taskVersionKey(item)] ?? (item.done === true)).length, 0);
  const lastRequestAtRef = useRef(Number.isFinite(initialCheckedMs) ? initialCheckedMs : Number.NEGATIVE_INFINITY);
  const mountedRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async (force = false) => {
    const startedAt = Date.now();
    if (!shouldRefreshOperationsInbox(document.visibilityState === "visible", inFlightRef.current, startedAt, lastRequestAtRef.current, force)) return;
    const attentionRevisionAtStart = attentionMutationRevisionRef.current;
    lastRequestAtRef.current = startedAt;
    inFlightRef.current = true;
    setRefreshing(true);
    const request = new AbortController();
    controllerRef.current = request;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; request.abort(); }, 15_000);
    try {
      const response = await fetch("/api/staff/overview", { cache: "no-store", credentials: "same-origin", signal: request.signal });
      if (response.status === 401 || response.status === 403) {
        if (mountedRef.current) {
          setAlerts([]);
          setAccessExpired(true);
          setRefreshFailed(false);
        }
        return;
      }
      if (!response.ok) throw new Error("Overview refresh failed");
      const result = await response.json() as OverviewRefreshResponse;
      if (!Array.isArray(result.alerts) || typeof result.checkedAt !== "string") throw new Error("Overview response is invalid");
      if (mountedRef.current && canApplyOperationsRefresh(attentionRevisionAtStart, attentionMutationRevisionRef.current)) {
        setAlerts(result.alerts);
        setDoneOverrides({});
        setCheckedAt(result.checkedAt);
        setRefreshFailed(false);
        setAccessExpired(false);
      }
    } catch {
      if (mountedRef.current && (!request.signal.aborted || timedOut)) setRefreshFailed(true);
    } finally {
      window.clearTimeout(timeout);
      if (controllerRef.current === request) controllerRef.current = null;
      inFlightRef.current = false;
      if (mountedRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const refreshOnFocus = () => { void refresh(); };
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const interval = window.setInterval(() => { void refresh(); }, OPERATIONS_INBOX_REFRESH_MS);
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      mountedRef.current = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnVisible);
      controllerRef.current?.abort();
    };
  }, [refresh]);

  const updateDone = (item: OperationsWorkItem, done: boolean) => {
    attentionMutationRevisionRef.current += 1;
    setDoneOverrides((current) => ({ ...current, [taskVersionKey(item)]: done }));
  };

  return (
    <aside className={styles.alertSection} aria-label="Operations needing attention">
      <div className={styles.alertHeader}>
        <div><h2>Needs attention</h2><p>{hasOpenWork ? `${activeAlerts.length} queues with open work` : "No open work in your queues"}</p></div>
        <span aria-label={`${activeAlerts.length} queues with open work`}>{activeAlerts.length}</span>
      </div>
      <div className={styles.inboxControls}>
        <p>Marking a preview Done hides it for you. It does not close the order, case, or queue item.</p>
        {doneCount > 0 && <button className={styles.showDone} type="button" aria-pressed={showDone} onClick={() => setShowDone((visible) => !visible)}>{showDone ? "Hide done" : `Show done (${doneCount})`}</button>}
      </div>
      <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">{attentionMessage}</span>
      {hasOpenWork ? <ul className={styles.alertList}>{activeAlerts.map((alert) => (
        <li className={styles.alert} key={alert.key}>
          <div className={styles.alertTitle}>
            <div><h3>{alert.title}</h3><p>{alert.description}</p></div>
            <span className={styles.alertCount}>{operationsCountLabel(alert.count, alert.noun, alert.saturated)}</span>
          </div>
          {alert.items.length ? <>
            <ul className={styles.taskList}>{alert.items.map((item) => (
              <OverviewTask key={taskVersionKey(item)} item={item} done={doneOverrides[taskVersionKey(item)] ?? (item.done === true)} showDone={showDone} onDoneChange={updateDone} onMessage={setAttentionMessage} onRefresh={() => { void refresh(true); }} />
            ))}</ul>
            {alert.items.every((item) => doneOverrides[taskVersionKey(item)] ?? (item.done === true)) && !showDone && <p className={styles.noPreview}>All previewed items are marked Done. Additional records may remain in this queue.</p>}
          </> : <p className={styles.noPreview}>Open the queue to review its current records.</p>}
          <Link className={styles.queueAction} href={alert.href}>{alert.action} <span aria-hidden="true">↗</span></Link>
        </li>
      ))}</ul> : <p className={styles.alertEmpty}>No open workflow items need action. Completed work leaves this list through its audited workflow.</p>}
      <div className={styles.refreshStatus}>
        <span role="status" aria-live="polite" aria-atomic="true">{accessExpired ? "Staff access changed. Reload this page to continue." : refreshFailed ? "Could not refresh. Showing the last successful check." : refreshing ? "Checking for updates…" : "Updates automatically about every minute while this page is visible."}</span>
        {!accessExpired && <time dateTime={checkedAt}>Checked {checkedTime(checkedAt)}</time>}
        {!accessExpired && <button className={styles.refreshRetry} type="button" onClick={() => { void refresh(true); }} disabled={refreshing}>{refreshFailed ? "Try again" : "Refresh now"}</button>}
        {accessExpired && <button className={styles.refreshRetry} type="button" onClick={() => window.location.reload()}>Reload Overview</button>}
      </div>
      <p className={styles.alertFootnote}>Queue counts include all current work. Use each linked workflow to make audited changes; Done only archives a preview in your personal Overview.</p>
      <div className={styles.notice}><span className={styles.noticeDot} /><p>Private order content remains limited to assigned Admins and audited Super Admin access.</p></div>
    </aside>
  );
}
