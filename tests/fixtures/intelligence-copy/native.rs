// Read by tests/no-intelligence-in-user-copy.test.ts: two native strings a window shows, which the
// scan must catch, and a log line, a comment and a test it must pass over. Intelligence here is a
// comment.
fn said() -> &'static str {
    "The Intelligence dashboard"
}

fn line() {
    eprintln!("[intelligence] Intelligence could not start");
}

const ITEM: &str = "Open Intelligence \
    dashboard";

#[cfg(test)]
mod tests {
    const SAID: &str = "Intelligence in a test";
}
