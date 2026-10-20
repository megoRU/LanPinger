use crate::{emit, target};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::future::Future;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::{broadcast, watch, Semaphore};
use tokio::task::JoinSet;
use tokio::time::{interval, timeout, MissedTickBehavior};
use tracert::node::{Node, NodeType};
use tracert::protocol::Protocol;
use tracert::trace::{TraceResult, TraceStatus, Tracer};

pub(crate) const MAX_HOPS: u8 = 24;
const RECEIVE_TIMEOUT: Duration = Duration::from_millis(650);
const TRACE_TIMEOUT: Duration = Duration::from_secs(18);
const MAX_ROWS: usize = 96;
const RTT_HISTORY_LIMIT: usize = 256;

#[derive(Default)]
pub(crate) struct MonitorRegistry {
    next_id: std::sync::atomic::AtomicU64,
    active: Mutex<Option<ActiveMonitor>>,
}

struct ActiveMonitor {
    id: String,
    cancel: watch::Sender<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    session_id: String,
    status: String,
    host: String,
    resolved_ip: Option<String>,
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    session_id: String,
    current_hop: u8,
    max_hops: u8,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitorUpdate {
    session_id: String,
    host: String,
    resolved_ip: String,
    elapsed_ms: u64,
    current_hop: u8,
    max_hops: u8,
    reached_destination: bool,
    rows: Vec<HopView>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HopView {
    hop: u8,
    host: String,
    ip: String,
    sent: u64,
    received: u64,
    loss_percent: f64,
    best_ms: Option<f64>,
    average_ms: Option<f64>,
    worst_ms: Option<f64>,
    last_ms: Option<f64>,
    jitter_ms: Option<f64>,
    status: String,
}

#[derive(Default)]
struct HopStats {
    hop: u8,
    ip: String,
    host: String,
    sent: u64,
    received: u64,
    total_ms: f64,
    best_ms: Option<f64>,
    worst_ms: Option<f64>,
    last_ms: Option<f64>,
    recent_rtts_ms: VecDeque<f64>,
    recent_jitter_ms: VecDeque<f64>,
    last_seen_cycle: u64,
    last_probe_responded: bool,
    destination: bool,
}

impl HopStats {
    fn record(&mut self, response: Option<&Node>, cycle: u64) {
        self.sent = self.sent.saturating_add(1);
        self.last_seen_cycle = cycle;
        self.last_probe_responded = response.is_some();
        self.destination = response.is_some_and(|node| node.node_type == NodeType::Destination);
        if let Some(node) = response {
            let rtt_ms = node.rtt.as_secs_f64() * 1000.0;
            self.received = self.received.saturating_add(1);
            self.total_ms += rtt_ms;
            self.best_ms = Some(self.best_ms.map_or(rtt_ms, |best| best.min(rtt_ms)));
            self.worst_ms = Some(self.worst_ms.map_or(rtt_ms, |worst| worst.max(rtt_ms)));
            if let Some(previous) = self.recent_rtts_ms.back() {
                self.recent_jitter_ms.push_back((rtt_ms - *previous).abs());
                if self.recent_jitter_ms.len() > RTT_HISTORY_LIMIT - 1 {
                    self.recent_jitter_ms.pop_front();
                }
            }
            self.recent_rtts_ms.push_back(rtt_ms);
            if self.recent_rtts_ms.len() > RTT_HISTORY_LIMIT {
                self.recent_rtts_ms.pop_front();
            }
            self.last_ms = Some(rtt_ms);
            if !node.hostname.is_empty() {
                self.host.clone_from(&node.hostname);
            }
        }
    }

    fn view(&self, current_cycle: u64) -> HopView {
        let loss = if self.sent == 0 {
            0.0
        } else {
            (self.sent - self.received) as f64 * 100.0 / self.sent as f64
        };
        HopView {
            hop: self.hop,
            host: if self.host.is_empty() {
                "*".into()
            } else {
                self.host.clone()
            },
            ip: self.ip.clone(),
            sent: self.sent,
            received: self.received,
            loss_percent: loss,
            best_ms: self.best_ms,
            average_ms: (self.received > 0).then(|| self.total_ms / self.received as f64),
            worst_ms: self.worst_ms,
            last_ms: self.last_ms,
            jitter_ms: (!self.recent_jitter_ms.is_empty()).then(|| {
                self.recent_jitter_ms.iter().sum::<f64>() / self.recent_jitter_ms.len() as f64
            }),
            status: if self.last_seen_cycle != current_cycle {
                "stale".into()
            } else if self.destination {
                "destination".into()
            } else if self.last_probe_responded {
                "responding".into()
            } else {
                "timeout".into()
            },
        }
    }
}

impl MonitorRegistry {
    pub(crate) fn start(
        &self,
        app: AppHandle,
        raw_host: String,
        interval_ms: u64,
    ) -> Result<String, String> {
        if !(1_000..=60_000).contains(&interval_ms) {
            return Err("The trace interval must be between 1 and 60 seconds.".into());
        }
        let host = target::validate_host(&raw_host)?;
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .saturating_add(1)
            .to_string();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        {
            let mut active = self
                .active
                .lock()
                .map_err(|_| "The monitor state is unavailable.".to_string())?;
            if active.is_some() {
                return Err("A route monitor is already running.".into());
            }
            *active = Some(ActiveMonitor {
                id: id.clone(),
                cancel: cancel_tx,
            });
        }

        emit(
            &app,
            "monitor-status",
            StatusEvent {
                session_id: id.clone(),
                status: "resolving".into(),
                host: host.clone(),
                resolved_ip: None,
                message: Some("Resolving the destination name".into()),
            },
        );
        tauri::async_runtime::spawn(run_monitor(app, host, interval_ms, id.clone(), cancel_rx));
        Ok(id)
    }

    pub(crate) fn stop(&self, app: &AppHandle) -> Result<(), String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "The monitor state is unavailable.".to_string())?;
        let Some(active) = active.as_ref() else {
            return Ok(());
        };
        let _ = active.cancel.send(true);
        emit(
            app,
            "monitor-status",
            StatusEvent {
                session_id: active.id.clone(),
                status: "stopping".into(),
                host: String::new(),
                resolved_ip: None,
                message: Some("Stopping the active measurement".into()),
            },
        );
        Ok(())
    }

    pub(crate) fn cancel_on_exit(&self) {
        if let Ok(active) = self.active.lock() {
            if let Some(active) = active.as_ref() {
                let _ = active.cancel.send(true);
            }
        }
    }
}

async fn run_monitor(
    app: AppHandle,
    host: String,
    interval_ms: u64,
    session_id: String,
    mut cancel: watch::Receiver<bool>,
) {
    let started = Instant::now();
    let resolved = tokio::select! {
        _ = wait_cancelled(&mut cancel) => None,
        result = target::resolve(&host) => Some(result),
    };
    let Some(resolved) = resolved else {
        finish(&app, &session_id, "stopped", &host, None, None);
        return;
    };
    let target_ip = match resolved {
        Ok(ip) => ip,
        Err(error) => {
            finish(&app, &session_id, "error", &host, None, Some(error));
            return;
        }
    };
    let target_text = target_ip.to_string();
    emit(
        &app,
        "monitor-status",
        StatusEvent {
            session_id: session_id.clone(),
            status: "tracing".into(),
            host: host.clone(),
            resolved_ip: Some(target_text.clone()),
            message: Some("Destination resolved; discovering the route".into()),
        },
    );

    let mut stats: BTreeMap<(u8, String), HopStats> = BTreeMap::new();
    let mut reverse_names: BTreeMap<IpAddr, Option<String>> = BTreeMap::new();
    let reverse_limit = Arc::new(Semaphore::new(4));
    let mut cycle = 0_u64;
    let interval_duration = Duration::from_millis(interval_ms);

    loop {
        if *cancel.borrow() {
            break;
        }
        cycle = cycle.saturating_add(1);
        #[cfg(windows)]
        let trace_result = if let IpAddr::V4(address) = target_ip {
            let (progress_tx, progress_rx) = broadcast::channel(32);
            collect_trace(
                &app,
                &session_id,
                &mut cancel,
                crate::windows_trace::trace_ipv4(address, MAX_HOPS, RECEIVE_TIMEOUT, progress_tx),
                progress_rx,
            )
            .await
        } else {
            trace_with_tracert(&app, &session_id, target_ip, &mut cancel).await
        };
        #[cfg(not(windows))]
        let trace_result = trace_with_tracert(&app, &session_id, target_ip, &mut cancel).await;

        let Some(trace_result) = trace_result else {
            break;
        };
        let trace_result = match trace_result {
            Ok(result) => result,
            Err(error) => {
                finish(
                    &app,
                    &session_id,
                    "error",
                    &host,
                    Some(target_ip),
                    Some(format_probe_error(error)),
                );
                return;
            }
        };
        let mut nodes = trace_result.nodes;
        let reverse_result = tokio::select! {
            _ = wait_cancelled(&mut cancel) => None,
            _ = reverse_resolve(&mut nodes, &mut reverse_names, reverse_limit.clone()) => Some(()),
        };
        if reverse_result.is_none() {
            break;
        }

        let reached_hop = nodes
            .iter()
            .filter(|node| node.ip_addr == target_ip)
            .filter_map(|node| node.hop_count.or(Some(node.sequence)))
            .max();
        let attempted_hops = reached_hop.unwrap_or(MAX_HOPS).min(MAX_HOPS);
        let mut by_hop: BTreeMap<u8, &Node> = BTreeMap::new();
        for node in &mut nodes {
            if node.ip_addr == target_ip {
                node.node_type = NodeType::Destination;
            } else if node.node_type == NodeType::Destination {
                node.node_type = NodeType::Hop;
            }
        }
        for node in &nodes {
            let hop = node.hop_count.unwrap_or(node.sequence);
            if (1..=MAX_HOPS).contains(&hop) {
                by_hop.insert(hop, node);
            }
        }

        for hop in 1..=attempted_hops {
            if let Some(node) = by_hop.get(&hop) {
                stats.remove(&(hop, "*".into()));
                let ip = node.ip_addr.to_string();
                let entry = stats.entry((hop, ip.clone())).or_insert_with(|| HopStats {
                    hop,
                    ip,
                    host: node.hostname.clone(),
                    ..HopStats::default()
                });
                entry.record(Some(node), cycle);
            } else {
                let last_known_route = stats
                    .iter()
                    .filter(|((row_hop, ip), _)| *row_hop == hop && ip != "*")
                    .max_by_key(|(_, entry)| entry.last_seen_cycle)
                    .map(|(key, _)| key.clone());
                if let Some(key) = last_known_route {
                    if let Some(entry) = stats.get_mut(&key) {
                        entry.record(None, cycle);
                    }
                } else {
                    let entry = stats.entry((hop, "*".into())).or_insert_with(|| HopStats {
                        hop,
                        ip: "*".into(),
                        host: "*".into(),
                        ..HopStats::default()
                    });
                    entry.record(None, cycle);
                }
            }
        }
        trim_stats(&mut stats);

        let reached_destination = reached_hop.is_some();
        let rows = stats.values().map(|row| row.view(cycle)).collect();
        emit(
            &app,
            "monitor-update",
            MonitorUpdate {
                session_id: session_id.clone(),
                host: host.clone(),
                resolved_ip: target_text.clone(),
                elapsed_ms: started.elapsed().as_millis() as u64,
                current_hop: attempted_hops,
                max_hops: MAX_HOPS,
                reached_destination,
                rows,
            },
        );
        emit(
            &app,
            "monitor-progress",
            ProgressEvent {
                session_id: session_id.clone(),
                current_hop: attempted_hops,
                max_hops: MAX_HOPS,
            },
        );
        emit(
            &app,
            "monitor-status",
            StatusEvent {
                session_id: session_id.clone(),
                status: "running".into(),
                host: host.clone(),
                resolved_ip: Some(target_text.clone()),
                message: Some(if reached_destination {
                    format!("Destination answered in {} hops", attempted_hops)
                } else if trace_result.status == TraceStatus::Timeout {
                    "Trace reached its time limit; continuing with the next cycle".into()
                } else {
                    "No destination response; intermediate routers may filter ICMP".into()
                }),
            },
        );

        let wait_for_next = interval_duration.saturating_sub(trace_result.probe_time);
        tokio::select! {
            _ = wait_cancelled(&mut cancel) => break,
            _ = tokio::time::sleep(wait_for_next) => {},
        }
    }

    finish(&app, &session_id, "stopped", &host, Some(target_ip), None);
}

async fn trace_with_tracert(
    app: &AppHandle,
    session_id: &str,
    target_ip: IpAddr,
    cancel: &mut watch::Receiver<bool>,
) -> Option<Result<TraceResult, String>> {
    let mut tracer = match Tracer::new(target_ip) {
        Ok(tracer) => tracer,
        Err(error) => return Some(Err(error)),
    };
    tracer.set_protocol(if target_ip.is_ipv4() {
        Protocol::Icmpv4
    } else {
        Protocol::Icmpv6
    });
    tracer.set_max_hop(MAX_HOPS);
    tracer.set_receive_timeout(RECEIVE_TIMEOUT);
    tracer.set_trace_timeout(TRACE_TIMEOUT);
    let progress_rx = tracer.get_progress_receiver();
    collect_trace(app, session_id, cancel, tracer.trace_async(), progress_rx).await
}

async fn collect_trace<F>(
    app: &AppHandle,
    session_id: &str,
    cancel: &mut watch::Receiver<bool>,
    future: F,
    mut progress_rx: broadcast::Receiver<Node>,
) -> Option<Result<TraceResult, String>>
where
    F: Future<Output = Result<TraceResult, String>>,
{
    let trace_started = Instant::now();
    let mut trace_future = Box::pin(future);
    let mut progress_closed = false;
    let mut latest_hop = 0_u8;
    let mut progress_tick = interval(Duration::from_millis(250));
    progress_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = wait_cancelled(cancel) => return None,
            result = &mut trace_future => return Some(result),
            progress = progress_rx.recv(), if !progress_closed => {
                match progress {
                    Ok(node) => latest_hop = latest_hop.max(node.hop_count.unwrap_or(node.sequence)),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {},
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => progress_closed = true,
                }
            }
            _ = progress_tick.tick() => {
                let estimated = ((trace_started.elapsed().as_millis()
                    / RECEIVE_TIMEOUT.as_millis().max(1)) as u8)
                    .saturating_add(1)
                    .min(MAX_HOPS);
                emit(app, "monitor-progress", ProgressEvent {
                    session_id: session_id.into(),
                    current_hop: latest_hop.max(estimated),
                    max_hops: MAX_HOPS,
                });
            }
        }
    }
}

async fn reverse_resolve(
    nodes: &mut [Node],
    cache: &mut BTreeMap<IpAddr, Option<String>>,
    limit: Arc<Semaphore>,
) {
    let mut lookups = JoinSet::new();
    let mut unresolved = BTreeSet::new();
    for node in nodes.iter_mut() {
        let ip = node.ip_addr;
        let address_text = ip.to_string();
        if node.hostname != address_text {
            cache
                .entry(ip)
                .or_insert_with(|| Some(node.hostname.clone()));
            continue;
        }
        if let Some(host) = cache.get(&ip) {
            if let Some(host) = host {
                node.hostname.clone_from(host);
            }
            continue;
        }
        if !unresolved.insert(ip) {
            continue;
        }
        let semaphore = limit.clone();
        lookups.spawn(async move {
            let permit = semaphore.acquire_owned().await.ok()?;
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                (ip, dns_lookup::lookup_addr(&ip).ok())
            })
            .await
            .ok()
        });
    }
    let mut resolved = BTreeMap::new();
    let _ = timeout(Duration::from_secs(2), async {
        while let Some(result) = lookups.join_next().await {
            if let Some((ip, Some(host))) = result.ok().flatten() {
                resolved.insert(ip, host);
            }
        }
    })
    .await;
    for ip in unresolved {
        cache.insert(ip, resolved.remove(&ip));
    }
    while cache.len() > MAX_ROWS {
        cache.pop_first();
    }
    for node in nodes {
        if let Some(Some(host)) = cache.get(&node.ip_addr) {
            node.hostname.clone_from(host);
        }
    }
}

async fn wait_cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

fn finish(
    app: &AppHandle,
    session_id: &str,
    status: &str,
    host: &str,
    address: Option<IpAddr>,
    message: Option<String>,
) {
    emit(
        app,
        "monitor-status",
        StatusEvent {
            session_id: session_id.into(),
            status: status.into(),
            host: host.into(),
            resolved_ip: address.map(|ip| ip.to_string()),
            message,
        },
    );
    let state = app.state::<crate::AppState>();
    if let Ok(mut active) = state.monitors.active.lock() {
        if active
            .as_ref()
            .is_some_and(|monitor| monitor.id == session_id)
        {
            *active = None;
        }
    };
}

fn format_probe_error(error: String) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("permission")
        || lower.contains("denied")
        || lower.contains("operation not permitted")
    {
        format!("ICMP socket permission denied. On Linux grant CAP_NET_RAW or run with elevated privileges. Details: {error}")
    } else {
        format!("ICMP route probe failed: {error}")
    }
}

fn trim_stats(stats: &mut BTreeMap<(u8, String), HopStats>) {
    while stats.len() > MAX_ROWS {
        let oldest = stats
            .iter()
            .min_by_key(|(_, value)| value.last_seen_cycle)
            .map(|(key, _)| key.clone());
        if let Some(key) = oldest {
            stats.remove(&key);
        } else {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{trim_stats, wait_cancelled, HopStats, Node, MAX_ROWS, RTT_HISTORY_LIMIT};
    use std::collections::BTreeMap;
    use std::net::{IpAddr, Ipv4Addr};
    use std::time::Duration;
    use tracert::node::NodeType;

    fn sample(hop: u8, milliseconds: u64, destination: bool) -> Node {
        Node {
            sequence: hop,
            ip_addr: IpAddr::V4(Ipv4Addr::new(192, 0, 2, hop)),
            hostname: format!("router-{hop}"),
            ttl: None,
            hop_count: Some(hop),
            node_type: if destination {
                NodeType::Destination
            } else {
                NodeType::Hop
            },
            rtt: Duration::from_millis(milliseconds),
        }
    }

    #[test]
    fn computes_loss_and_rtt_aggregates() {
        let mut stats = HopStats {
            hop: 1,
            ip: "192.0.2.1".into(),
            host: "router-1".into(),
            ..HopStats::default()
        };
        stats.record(Some(&sample(1, 10, false)), 1);
        stats.record(None, 2);
        stats.record(Some(&sample(1, 30, false)), 3);
        let view = stats.view(3);
        assert_eq!(view.sent, 3);
        assert_eq!(view.received, 2);
        assert!((view.loss_percent - 33.333_333).abs() < 0.001);
        assert_eq!(view.best_ms, Some(10.0));
        assert_eq!(view.average_ms, Some(20.0));
        assert_eq!(view.worst_ms, Some(30.0));
        assert_eq!(view.last_ms, Some(30.0));
    }

    #[test]
    fn jitter_is_the_mean_absolute_change_between_successful_samples() {
        let mut stats = HopStats {
            hop: 1,
            ip: "192.0.2.1".into(),
            host: "router-1".into(),
            ..HopStats::default()
        };
        stats.record(Some(&sample(1, 10, false)), 1);
        stats.record(Some(&sample(1, 16, false)), 2);
        stats.record(Some(&sample(1, 20, false)), 3);
        assert_eq!(stats.view(3).jitter_ms, Some(5.0));
    }

    #[test]
    fn a_destination_reply_is_classified_separately() {
        let mut stats = HopStats {
            hop: 3,
            ip: "192.0.2.3".into(),
            host: "host".into(),
            ..HopStats::default()
        };
        stats.record(Some(&sample(3, 12, true)), 1);
        assert_eq!(stats.view(1).status, "destination");
    }

    #[test]
    fn old_route_variants_are_marked_stale() {
        let mut stats = HopStats {
            hop: 2,
            ip: "192.0.2.2".into(),
            host: "router-2".into(),
            ..HopStats::default()
        };
        stats.record(Some(&sample(2, 12, false)), 1);
        assert_eq!(stats.view(2).status, "stale");
    }

    #[test]
    fn route_history_has_a_hard_row_limit() {
        let mut stats = BTreeMap::new();
        for index in 0..(MAX_ROWS + 5) {
            let ip = format!("192.0.2.{index}");
            stats.insert(
                (1, ip.clone()),
                HopStats {
                    hop: 1,
                    ip,
                    host: String::new(),
                    last_seen_cycle: index as u64,
                    ..HopStats::default()
                },
            );
        }
        trim_stats(&mut stats);
        assert_eq!(stats.len(), MAX_ROWS);
        assert!(!stats.contains_key(&(1, "192.0.2.0".into())));
    }

    #[tokio::test]
    async fn cancellation_wakes_the_monitor_worker() {
        let (cancel, mut receiver) = tokio::sync::watch::channel(false);
        let waiter = tokio::spawn(async move { wait_cancelled(&mut receiver).await });
        cancel.send(true).unwrap();
        tokio::time::timeout(Duration::from_millis(100), waiter)
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn measurement_history_is_bounded() {
        let mut stats = HopStats {
            hop: 1,
            ip: "192.0.2.1".into(),
            host: "router-1".into(),
            ..HopStats::default()
        };
        for index in 0..(RTT_HISTORY_LIMIT + 80) {
            stats.record(Some(&sample(1, (index % 20) as u64, false)), index as u64);
        }
        assert_eq!(stats.recent_rtts_ms.len(), RTT_HISTORY_LIMIT);
        assert_eq!(stats.recent_jitter_ms.len(), RTT_HISTORY_LIMIT - 1);
    }
}
