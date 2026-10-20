use std::mem::size_of;
use std::net::{IpAddr, Ipv4Addr};
use std::ptr;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
use tokio::task::JoinSet;
use tracert::node::{Node, NodeType};
use tracert::trace::{TraceResult, TraceStatus};
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho, ICMP_ECHO_REPLY, IP_DEST_HOST_UNREACHABLE,
    IP_DEST_NET_UNREACHABLE, IP_DEST_PORT_UNREACHABLE, IP_DEST_PROHIBITED, IP_OPTION_INFORMATION,
    IP_SUCCESS, IP_TTL_EXPIRED_REASSEM, IP_TTL_EXPIRED_TRANSIT,
};

const REQUEST_DATA: &[u8] = b"LanPinger route probe........";
const REPLY_BUFFER_WORDS: usize = 64;

pub(crate) async fn trace_ipv4(
    target: Ipv4Addr,
    max_hops: u8,
    receive_timeout: Duration,
    progress: broadcast::Sender<Node>,
) -> Result<TraceResult, String> {
    let started = Instant::now();
    let mut probes = JoinSet::new();

    for hop in 1..=max_hops {
        let _ = progress.send(Node {
            sequence: hop,
            ip_addr: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            hostname: String::new(),
            ttl: None,
            hop_count: Some(hop),
            node_type: NodeType::Hop,
            rtt: Duration::ZERO,
        });

        probes.spawn_blocking(move || probe_hop(target, hop, receive_timeout));
    }

    let mut nodes = Vec::new();
    while let Some(result) = probes.join_next().await {
        let node = result.map_err(|error| format!("Windows ICMP probe task failed: {error}"))??;
        if let Some(node) = node {
            nodes.push(node);
        }
    }
    nodes.sort_by_key(|node| node.sequence);
    if let Some(destination_hop) = nodes
        .iter()
        .filter(|node| node.node_type == NodeType::Destination)
        .map(|node| node.sequence)
        .min()
    {
        nodes.retain(|node| node.sequence <= destination_hop);
    }

    Ok(TraceResult {
        nodes,
        status: TraceStatus::Done,
        probe_time: started.elapsed(),
    })
}

fn probe_hop(target: Ipv4Addr, hop: u8, receive_timeout: Duration) -> Result<Option<Node>, String> {
    // IcmpSendEcho waits synchronously, so each hop runs on Tokio's blocking pool.
    let handle = unsafe { IcmpCreateFile() };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "Could not create a Windows ICMP handle: {}",
            std::io::Error::last_os_error()
        ));
    }
    let _handle = IcmpHandle(handle);

    let mut options = IP_OPTION_INFORMATION::default();
    options.Ttl = hop;
    let mut reply_buffer = [0_u64; REPLY_BUFFER_WORDS];
    let timeout_ms = receive_timeout.as_millis().min(u32::MAX as u128) as u32;

    // IcmpSendEcho expects the IPv4 address in network byte order. On Windows,
    // the native integer representation preserves the octet sequence in memory.
    let destination = u32::from_ne_bytes(target.octets());
    let reply_count = unsafe {
        IcmpSendEcho(
            handle,
            destination,
            REQUEST_DATA.as_ptr().cast(),
            REQUEST_DATA.len() as u16,
            &options,
            reply_buffer.as_mut_ptr().cast(),
            size_of::<[u64; REPLY_BUFFER_WORDS]>() as u32,
            timeout_ms,
        )
    };
    if reply_count == 0 {
        return Ok(None);
    }

    let reply = unsafe { ptr::read(reply_buffer.as_ptr().cast::<ICMP_ECHO_REPLY>()) };
    let address = Ipv4Addr::from(reply.Address.to_ne_bytes());
    if address.is_unspecified() {
        return Ok(None);
    }

    let address = IpAddr::V4(address);
    let node_type = if reply.Status == IP_SUCCESS && address == IpAddr::V4(target) {
        NodeType::Destination
    } else if matches!(
        reply.Status,
        IP_SUCCESS
            | IP_TTL_EXPIRED_TRANSIT
            | IP_TTL_EXPIRED_REASSEM
            | IP_DEST_NET_UNREACHABLE
            | IP_DEST_HOST_UNREACHABLE
            | IP_DEST_PORT_UNREACHABLE
            | IP_DEST_PROHIBITED
    ) {
        NodeType::Hop
    } else {
        return Ok(None);
    };

    Ok(Some(Node {
        sequence: hop,
        ip_addr: address,
        hostname: address.to_string(),
        ttl: None,
        hop_count: Some(hop),
        node_type,
        rtt: Duration::from_millis(reply.RoundTripTime as u64),
    }))
}

struct IcmpHandle(HANDLE);

impl Drop for IcmpHandle {
    fn drop(&mut self) {
        unsafe {
            IcmpCloseHandle(self.0);
        }
    }
}
