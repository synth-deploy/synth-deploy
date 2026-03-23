/**
 * Alert payload parsers for external monitoring system webhooks.
 *
 * Each parser normalizes the raw webhook body from a specific alerting
 * platform into a common NormalizedAlert structure that Synth uses to
 * spawn operations.
 */

import type { NormalizedAlert, AlertWebhookSource } from "@synth-deploy/core";

// ---------------------------------------------------------------------------
// Prometheus AlertManager
// ---------------------------------------------------------------------------

interface PrometheusAlert {
  status: "firing" | "resolved";
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
}

interface PrometheusPayload {
  version?: string;
  status?: string;
  alerts?: PrometheusAlert[];
}

export function parsePrometheusAlerts(body: unknown): NormalizedAlert[] {
  const payload = body as PrometheusPayload;
  if (!payload?.alerts || !Array.isArray(payload.alerts)) return [];

  return payload.alerts
    .filter((a) => a.status === "firing")
    .map((alert): NormalizedAlert => ({
      name: alert.labels?.alertname ?? "Unknown",
      summary: alert.annotations?.summary ?? alert.annotations?.description ?? alert.labels?.alertname ?? "Alert fired",
      severity: normalizeSeverity(alert.labels?.severity),
      status: alert.status,
      labels: alert.labels ?? {},
      annotations: alert.annotations ?? {},
      source: "prometheus",
      startsAt: alert.startsAt ? new Date(alert.startsAt) : undefined,
      rawPayload: alert as unknown as Record<string, unknown>,
    }));
}

// ---------------------------------------------------------------------------
// PagerDuty (v2 webhook / Events API v2)
// ---------------------------------------------------------------------------

interface PagerDutyMessage {
  event?: string;
  incident?: {
    title?: string;
    urgency?: string;
    status?: string;
    service?: { name?: string };
    created_at?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface PagerDutyPayload {
  messages?: PagerDutyMessage[];
  event?: { event_type?: string; data?: Record<string, unknown> };
  [key: string]: unknown;
}

export function parsePagerDutyAlerts(body: unknown): NormalizedAlert[] {
  const payload = body as PagerDutyPayload;

  // V3 webhook format (event.event_type / event.data)
  if (payload?.event?.event_type) {
    const evt = payload.event;
    const data = (evt.data ?? {}) as Record<string, unknown>;
    const isFiring = String(evt.event_type).includes("triggered");
    if (!isFiring) return [];

    return [{
      name: String(data.title ?? "PagerDuty Alert"),
      summary: String(data.title ?? evt.event_type),
      severity: normalizeSeverity(String(data.urgency ?? data.priority ?? "warning")),
      status: "firing",
      labels: { service: String((data.service as Record<string, unknown>)?.name ?? "unknown") },
      annotations: {},
      source: "pagerduty",
      startsAt: data.created_at ? new Date(String(data.created_at)) : undefined,
      rawPayload: payload as Record<string, unknown>,
    }];
  }

  // V2 webhook format (messages array)
  if (!payload?.messages || !Array.isArray(payload.messages)) return [];

  return payload.messages
    .filter((m) => m.event === "incident.trigger")
    .map((msg): NormalizedAlert => {
      const inc = msg.incident ?? {};
      return {
        name: String(inc.title ?? "PagerDuty Incident"),
        summary: String(inc.title ?? "Incident triggered"),
        severity: normalizeSeverity(String(inc.urgency ?? "warning")),
        status: "firing",
        labels: { service: String(inc.service?.name ?? "unknown") },
        annotations: {},
        source: "pagerduty",
        startsAt: inc.created_at ? new Date(String(inc.created_at)) : undefined,
        rawPayload: msg as unknown as Record<string, unknown>,
      };
    });
}

// ---------------------------------------------------------------------------
// Datadog
// ---------------------------------------------------------------------------

interface DatadogPayload {
  title?: string;
  text?: string;
  alert_type?: string;
  priority?: string;
  tags?: string[];
  date?: number;
  event_type?: string;
  alert_transition?: string;
  [key: string]: unknown;
}

export function parseDatadogAlerts(body: unknown): NormalizedAlert[] {
  const payload = body as DatadogPayload;
  if (!payload?.title) return [];

  // Only fire on "Triggered" transitions (not "Recovered" or "No Data")
  const transition = String(payload.alert_transition ?? "Triggered");
  if (transition !== "Triggered") return [];

  const labels: Record<string, string> = {};
  if (payload.tags) {
    for (const tag of payload.tags) {
      const [k, ...v] = tag.split(":");
      labels[k] = v.join(":") || "true";
    }
  }

  return [{
    name: payload.title,
    summary: payload.text ?? payload.title,
    severity: normalizeSeverity(payload.alert_type ?? payload.priority ?? "warning"),
    status: "firing",
    labels,
    annotations: {},
    source: "datadog",
    startsAt: payload.date ? new Date(payload.date * 1000) : undefined,
    rawPayload: payload as Record<string, unknown>,
  }];
}

// ---------------------------------------------------------------------------
// Grafana (Unified Alerting webhook)
// ---------------------------------------------------------------------------

interface GrafanaAlert {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  [key: string]: unknown;
}

interface GrafanaPayload {
  status?: string;
  alerts?: GrafanaAlert[];
  title?: string;
  message?: string;
  [key: string]: unknown;
}

export function parseGrafanaAlerts(body: unknown): NormalizedAlert[] {
  const payload = body as GrafanaPayload;

  // Unified Alerting format (same shape as Prometheus)
  if (payload?.alerts && Array.isArray(payload.alerts)) {
    return payload.alerts
      .filter((a) => (a.status ?? "firing") === "firing")
      .map((alert): NormalizedAlert => ({
        name: alert.labels?.alertname ?? payload.title ?? "Grafana Alert",
        summary: alert.annotations?.summary ?? alert.annotations?.description ?? payload.message ?? "Alert fired",
        severity: normalizeSeverity(alert.labels?.severity),
        status: "firing",
        labels: alert.labels ?? {},
        annotations: alert.annotations ?? {},
        source: "grafana",
        startsAt: alert.startsAt ? new Date(alert.startsAt) : undefined,
        rawPayload: alert as unknown as Record<string, unknown>,
      }));
  }

  // Legacy notification format (single alert in body)
  if (payload?.title) {
    return [{
      name: payload.title,
      summary: String(payload.message ?? payload.title),
      severity: normalizeSeverity(String(payload.status ?? "warning")),
      status: payload.status === "resolved" ? "resolved" : "firing",
      labels: {},
      annotations: {},
      source: "grafana",
      rawPayload: payload as Record<string, unknown>,
    }];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Generic — accepts a simple JSON shape for custom integrations
// ---------------------------------------------------------------------------

interface GenericPayload {
  name?: string;
  summary?: string;
  severity?: string;
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  [key: string]: unknown;
}

export function parseGenericAlerts(body: unknown): NormalizedAlert[] {
  const payload = body as GenericPayload;
  if (!payload || typeof payload !== "object") return [];

  const status = (payload.status ?? "firing") === "resolved" ? "resolved" as const : "firing" as const;
  if (status === "resolved") return [];

  return [{
    name: String(payload.name ?? "External Alert"),
    summary: String(payload.summary ?? payload.name ?? "Alert received"),
    severity: normalizeSeverity(payload.severity),
    status,
    labels: payload.labels ?? {},
    annotations: payload.annotations ?? {},
    source: "generic",
    rawPayload: payload as Record<string, unknown>,
  }];
}

// ---------------------------------------------------------------------------
// Router — pick the right parser based on source
// ---------------------------------------------------------------------------

export function parseAlerts(source: AlertWebhookSource, body: unknown): NormalizedAlert[] {
  switch (source) {
    case "prometheus": return parsePrometheusAlerts(body);
    case "pagerduty": return parsePagerDutyAlerts(body);
    case "datadog": return parseDatadogAlerts(body);
    case "grafana": return parseGrafanaAlerts(body);
    case "generic": return parseGenericAlerts(body);
    default: return parseGenericAlerts(body);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSeverity(raw?: string): "critical" | "warning" | "info" {
  if (!raw) return "warning";
  const lower = raw.toLowerCase();
  if (lower === "critical" || lower === "error" || lower === "high" || lower === "p1") return "critical";
  if (lower === "info" || lower === "low" || lower === "p3" || lower === "p4" || lower === "ok") return "info";
  return "warning";
}

/**
 * Interpolate alert fields into an intent template.
 * Supported placeholders: {{alert.name}}, {{alert.summary}}, {{alert.severity}},
 * {{alert.labels.<key>}}, {{alert.annotations.<key>}}.
 */
export function interpolateIntent(template: string, alert: NormalizedAlert): string {
  return template
    .replace(/\{\{alert\.name\}\}/g, alert.name)
    .replace(/\{\{alert\.summary\}\}/g, alert.summary)
    .replace(/\{\{alert\.severity\}\}/g, alert.severity)
    .replace(/\{\{alert\.labels\.(\w+)\}\}/g, (_, key) => alert.labels[key] ?? "")
    .replace(/\{\{alert\.annotations\.(\w+)\}\}/g, (_, key) => alert.annotations[key] ?? "");
}
