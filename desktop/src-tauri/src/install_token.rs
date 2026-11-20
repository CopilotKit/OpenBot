/*!
The install's own token, which the personal edition only admits requests carrying.

Minted once per deployment with the other secrets (`env::MINTED`), kept in the credential store and
never in `.env` (`vault::is_secret`), and handed to the `server` container alone through Compose
(`docker-compose.yml`). A request is the person's when it carries it, either as the cookie the entry
address sets or as [`HEADER`].

- A window enters the owned OpenBot through [`entry`] the first time it loads it, so the page gets
  the cookie; every later load on that origin carries it.
- A native caller (the Recorder's native host) sends [`HEADER`].

A server from a release before this has no token in its environment and no entry address, and is
loaded and asked as before: [`entry`] given no token is the page itself.
*/

/// The setting the server reads, and the name the credential store keeps it under.
pub const NAME: &str = "OPENBOT_INSTALL_TOKEN";

/// The header a native caller sends it in.
pub const HEADER: &str = "X-OpenBot-Install-Token";

/// The address that sets the cookie and sends the window on to `to`.
pub const ENTRY_PATH: &str = "/api/install/enter";

/// Where a window opens `destination` on its owned OpenBot: through the entry address on the same
/// origin when the server was given a token, so the page arrives with the cookie, and at
/// `destination` itself when it was given none.
pub fn entry(destination: &reqwest::Url, token: Option<&str>) -> reqwest::Url {
    let Some(token) = token.filter(|token| !token.trim().is_empty()) else {
        return destination.clone();
    };
    // The page to go on to, on this origin. The server sends the window there and nowhere else, so
    // a path that would name another host is home instead.
    let mut to = destination.path().to_owned();
    if to.starts_with("//") || !to.starts_with('/') {
        to = "/".to_owned();
    }
    if let Some(query) = destination.query() {
        to.push('?');
        to.push_str(query);
    }
    if let Some(fragment) = destination.fragment() {
        to.push('#');
        to.push_str(fragment);
    }
    let mut entered = destination.clone();
    entered.set_path(ENTRY_PATH);
    entered.set_query(None);
    entered.set_fragment(None);
    entered
        .query_pairs_mut()
        .append_pair("token", token)
        .append_pair("to", &to);
    entered
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> reqwest::Url {
        text.parse().unwrap()
    }

    fn query(entered: &reqwest::Url) -> Vec<(String, String)> {
        entered
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect()
    }

    #[test]
    fn a_window_enters_through_the_entry_address_on_the_same_origin() {
        let entered = entry(
            &url("http://127.0.0.1:3010/settings/this-computer"),
            Some("tok-abc_123"),
        );
        assert_eq!(entered.origin(), url("http://127.0.0.1:3010/").origin());
        assert_eq!(entered.path(), ENTRY_PATH);
        assert_eq!(
            query(&entered),
            [
                ("token".to_string(), "tok-abc_123".to_string()),
                ("to".to_string(), "/settings/this-computer".to_string()),
            ]
        );
        assert_eq!(entered.fragment(), None);
    }

    #[test]
    fn the_page_it_goes_on_to_keeps_its_query_and_fragment_and_defaults_to_home() {
        let entered = entry(&url("http://[::1]:3010/channel/c-1?x=1&y=2#end"), Some("t"));
        assert_eq!(entered.host_str(), Some("[::1]"));
        assert_eq!(
            query(&entered),
            [
                ("token".to_string(), "t".to_string()),
                ("to".to_string(), "/channel/c-1?x=1&y=2#end".to_string()),
            ]
        );
        assert_eq!(entered.fragment(), None);

        let home = entry(&url("http://127.0.0.1:3010"), Some("t"));
        assert_eq!(query(&home)[1], ("to".to_string(), "/".to_string()));
    }

    /// A token with characters a query gives meaning to arrives as it was minted.
    #[test]
    fn the_token_is_encoded_so_the_server_reads_it_back_exactly() {
        let token = "a+b/c=d&e f";
        let entered = entry(&url("http://127.0.0.1:3010/"), Some(token));
        assert!(!entered.as_str().contains("a+b"), "{entered}");
        assert_eq!(query(&entered)[0], ("token".to_string(), token.to_string()));
    }

    /// A server from a release before the token, or a page not yet given one, is loaded as it is:
    /// such a server has no entry address to answer.
    #[test]
    fn without_a_token_the_window_loads_the_page_itself() {
        let page = url("http://127.0.0.1:3010/settings/this-computer");
        assert_eq!(entry(&page, None), page);
        assert_eq!(entry(&page, Some("")), page);
        assert_eq!(entry(&page, Some("  ")), page);
    }

    /// Only a path on this origin is somewhere the server sends the window on to.
    #[test]
    fn a_path_that_would_leave_the_origin_goes_home_instead() {
        let entered = entry(
            &url("http://127.0.0.1:3010//elsewhere.example/x"),
            Some("t"),
        );
        assert_eq!(query(&entered)[1], ("to".to_string(), "/".to_string()));
    }
}
