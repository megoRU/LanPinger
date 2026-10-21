use std::net::{IpAddr, SocketAddr};
use tokio::net::lookup_host;
use tokio::time::{timeout, Duration};

const DNS_TIMEOUT: Duration = Duration::from_secs(8);

pub fn validate_host(input: &str) -> Result<String, String> {
    let value = input.trim();
    if value.is_empty() {
        return Err("Enter a host name or IP address.".into());
    }
    if value.len() > 253 || value.chars().any(char::is_whitespace) {
        return Err("The host name is too long or contains spaces.".into());
    }

    let unwrapped = value
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(value);
    if let Ok(address) = unwrapped.parse::<IpAddr>() {
        return Ok(address.to_string());
    }

    let normalized = value.strip_suffix('.').unwrap_or(value);
    let (wildcard, domain) = normalized
        .strip_prefix("*.")
        .map(|domain| (true, domain))
        .unwrap_or((false, normalized));
    if domain.is_empty() {
        return Err("Use an IP address or a valid domain name.".into());
    }
    let ascii = idna::domain_to_ascii(domain)
        .map_err(|_| "The domain name could not be converted to a valid network name.")?;
    let valid = ascii.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    });
    if !valid {
        return Err("The host name contains an invalid character.".into());
    }
    let ascii = ascii.to_ascii_lowercase();
    Ok(if wildcard {
        format!("*.{ascii}")
    } else {
        ascii
    })
}

pub async fn resolve(host: &str) -> Result<IpAddr, String> {
    if let Ok(address) = host.parse::<IpAddr>() {
        return Ok(address);
    }
    let lookup = timeout(DNS_TIMEOUT, lookup_host((host, 0)))
        .await
        .map_err(|_| "DNS lookup timed out after 8 seconds.".to_string())?
        .map_err(|error| format!("DNS lookup failed: {error}"))?;
    let mut addresses: Vec<SocketAddr> = lookup.collect();
    addresses.sort_by_key(|address| !address.is_ipv4());
    addresses
        .first()
        .map(SocketAddr::ip)
        .ok_or_else(|| "DNS returned no IPv4 or IPv6 addresses.".into())
}

#[cfg(test)]
mod tests {
    use super::validate_host;

    #[test]
    fn accepts_ip_addresses_and_normalizes_ipv6_brackets() {
        assert_eq!(validate_host(" 192.0.2.1 ").unwrap(), "192.0.2.1");
        assert_eq!(validate_host("[2001:db8::1]").unwrap(), "2001:db8::1");
    }

    #[test]
    fn accepts_domains_and_removes_a_trailing_dot() {
        assert_eq!(validate_host("Example.COM.").unwrap(), "example.com");
        assert_eq!(
            validate_host("münich.example").unwrap(),
            "xn--mnich-kva.example"
        );
    }

    #[test]
    fn rejects_urls_ports_and_command_like_input() {
        assert!(validate_host("https://example.com").is_err());
        assert!(validate_host("example.com:443").is_err());
        assert!(validate_host("example.com;whoami").is_err());
        assert!(validate_host("bad host").is_err());
    }
}
